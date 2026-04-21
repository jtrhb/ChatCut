"""Cloudflare R2 client wrapper.

R2 is S3-API compatible — boto3 with a custom endpoint URL. Modal Secret
provides credentials. The client is constructed once per container;
boto3 manages connection pooling internally.

Bucket layout for previews (Phase 3):
    previews/{exploration_id}/{candidate_id}.mp4

The bucket has a 24h lifecycle policy on the previews/ prefix
(documented in services/gpu/README.md; applied via Cloudflare dashboard).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol

import boto3
from botocore.client import Config


@dataclass(frozen=True)
class R2Config:
    endpoint_url: str
    access_key_id: str
    secret_access_key: str
    bucket: str

    @classmethod
    def from_env(cls) -> R2Config:
        return cls(
            endpoint_url=_required("R2_ENDPOINT_URL"),
            access_key_id=_required("R2_ACCESS_KEY_ID"),
            secret_access_key=_required("R2_SECRET_ACCESS_KEY"),
            bucket=_required("R2_BUCKET"),
        )


def _required(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(f"required env var {name} not set")
    return val


class _S3LikeClient(Protocol):
    def put_object(
        self, *, Bucket: str, Key: str, Body: bytes, ContentType: str
    ) -> object: ...

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None: ...

    def get_object(self, *, Bucket: str, Key: str) -> dict: ...


def _build_client(cfg: R2Config) -> _S3LikeClient:
    return boto3.client(
        "s3",
        endpoint_url=cfg.endpoint_url,
        aws_access_key_id=cfg.access_key_id,
        aws_secret_access_key=cfg.secret_access_key,
        config=Config(signature_version="s3v4"),
    )


class R2Uploader:
    """Uploads bytes to R2 under the agreed previews/ key shape.

    Constructor accepts an optional `client` kwarg so unit tests can pass a
    fake without moto — only the happy path needs put_object semantics.
    """

    def __init__(self, cfg: R2Config, client: _S3LikeClient | None = None):
        self._cfg = cfg
        self._client = client or _build_client(cfg)

    def upload_preview(
        self,
        *,
        exploration_id: str,
        candidate_id: str,
        body: bytes,
        content_type: str = "video/mp4",
    ) -> str:
        key = preview_storage_key(exploration_id, candidate_id)
        self._client.put_object(
            Bucket=self._cfg.bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
        )
        return key

    def download_to_path(self, *, key: str, dest_path: str) -> None:
        """Download an R2 object to a local file path.

        Used by Stage B asset_fetcher to pull source clips before render.
        """
        self._client.download_file(self._cfg.bucket, key, dest_path)

    def download_bytes(self, *, key: str) -> bytes:
        """Download an R2 object's contents as in-memory bytes.

        Used by Stage C.2 to fetch the candidate's serialized snapshot
        without writing a temp file. For larger blobs (source clips)
        prefer download_to_path which streams to disk.
        """
        response = self._client.get_object(Bucket=self._cfg.bucket, Key=key)
        return response["Body"].read()


_SAFE_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


def preview_storage_key(exploration_id: str, candidate_id: str) -> str:
    """Canonical preview key. Validates ids to block path traversal."""
    _validate_id(exploration_id)
    _validate_id(candidate_id)
    return f"previews/{exploration_id}/{candidate_id}.mp4"


def _validate_id(value: str) -> None:
    if not value:
        raise ValueError("id segment must not be empty")
    if any(c not in _SAFE_ID_CHARS for c in value):
        raise ValueError(f"id segment contains unsafe character: {value!r}")

"""Auth helpers for ChatCut GPU service.

Modal web endpoints invoke verify_api_key on the X-API-Key header value.
Two valid keys are supported simultaneously to allow rotation without
downtime — the secondary key is rotated to primary at the next deploy.
"""

from __future__ import annotations

import hmac
from collections.abc import Iterable


class AuthError(Exception):
    """Raised when X-API-Key is missing, blank, or doesn't match an expected value."""


def verify_api_key(provided: str | None, expected: Iterable[str | None]) -> None:
    """Constant-time-compare provided key against any of expected.

    Raises AuthError on mismatch. Filters falsy entries from `expected` so a
    blank Modal Secret doesn't accidentally accept blank input.
    """
    if not provided:
        raise AuthError("missing X-API-Key header")
    valid = [k for k in expected if k]
    if not valid:
        raise AuthError("server has no API keys configured")
    for candidate in valid:
        if hmac.compare_digest(provided, candidate):
            return
    raise AuthError("invalid X-API-Key")

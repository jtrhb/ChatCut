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
    """Check provided key against any of expected.

    Iterates through ALL configured keys (does not short-circuit on first
    match), so per-iteration timing doesn't leak which key matched. Each
    individual comparison uses hmac.compare_digest for constant-time
    semantics. Filters falsy entries from `expected` so a blank Modal
    Secret doesn't accidentally accept blank input.
    """
    if not provided:
        raise AuthError("missing X-API-Key header")
    valid = [k for k in expected if k]
    if not valid:
        raise AuthError("server has no API keys configured")
    matched = False
    for candidate in valid:
        # Compute first, OR after — never short-circuit the comparison itself.
        result = hmac.compare_digest(provided, candidate)
        matched = matched or result
    if not matched:
        raise AuthError("invalid X-API-Key")

import pytest

from src.auth import AuthError, verify_api_key


class TestVerifyApiKey:
    def test_accepts_matching_key(self):
        verify_api_key("good", ["good"])

    def test_accepts_secondary_during_rotation(self):
        verify_api_key("new", ["old", "new"])

    def test_rejects_missing(self):
        with pytest.raises(AuthError, match="missing"):
            verify_api_key(None, ["good"])

    def test_rejects_empty_string(self):
        with pytest.raises(AuthError, match="missing"):
            verify_api_key("", ["good"])

    def test_rejects_mismatch(self):
        with pytest.raises(AuthError, match="invalid"):
            verify_api_key("bad", ["good"])

    def test_rejects_when_no_keys_configured(self):
        with pytest.raises(AuthError, match="no API keys"):
            verify_api_key("anything", [])

    def test_filters_blank_expected_keys(self):
        # Common Modal Secret pitfall: empty env → blank string in iterable.
        with pytest.raises(AuthError, match="no API keys"):
            verify_api_key("anything", ["", None])

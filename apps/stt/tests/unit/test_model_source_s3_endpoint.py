"""``_s3_endpoint_and_tls`` / ``_make_s3_client`` — the S3 endpoint may carry a scheme.

The gateway's model-registry credential contract hands the resolver a URL
(`baseUrl`): the platform-storage fallback answers ``http://localhost:9000`` and
the console refuses to save an explicit row without an http(s) scheme. minio-py
refuses a scheme in its endpoint argument, so before this helper existed every
URL-form credential failed with "path in endpoint is not allowed" and the only
value that worked (a bare ``host:port``) was one the console would not accept.
The scheme must therefore be stripped and must decide TLS; a bare ``host:port``
keeps the settings-tier flag it always honoured.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from stt.models.source_resolver import (
    ModelSourceConfig,
    ModelSourceError,
    _make_s3_client,
    _s3_endpoint_and_tls,
)


@pytest.mark.parametrize(
    ("endpoint", "secure", "expected"),
    [
        # The platform-storage fallback: a plain-HTTP URL beats a settings flag saying TLS.
        ("http://localhost:9000", True, ("localhost:9000", False)),
        # An explicit https row beats a settings flag saying plain HTTP.
        ("https://minio.example:9443", False, ("minio.example:9443", True)),
        # A trailing slash is not a path.
        ("http://localhost:9000/", True, ("localhost:9000", False)),
        ("  https://minio.example  ", False, ("minio.example", True)),
        # Bare host:port keeps the flag — the pre-URL contract is unchanged.
        ("localhost:9000", False, ("localhost:9000", False)),
        ("minio.internal:9000", True, ("minio.internal:9000", True)),
    ],
)
def test_scheme_decides_tls_and_is_stripped(
    endpoint: str, secure: bool, expected: tuple[str, bool]
) -> None:
    assert _s3_endpoint_and_tls(endpoint, secure) == expected


@pytest.mark.parametrize(
    "endpoint",
    [
        "ftp://minio:9000",
        "s3://minio:9000",
        "http://",
        "http:///nohost",
        "http://minio:9000/some-bucket",
        "http://minio:9000?region=x",
        "http://minio:9000#frag",
    ],
)
def test_unknown_schemes_paths_and_queries_are_refused(endpoint: str) -> None:
    with pytest.raises(ModelSourceError):
        _s3_endpoint_and_tls(endpoint, True)


def _config(endpoint: str, **overrides) -> ModelSourceConfig:
    base: dict[str, object] = {
        "cache_dir": "/tmp/cache",
        "s3_endpoint": endpoint,
        "s3_access_key": "ak",
        "s3_secret_key": "sk",
        "s3_secure": True,
        "s3_cert_check": False,
    }
    base.update(overrides)
    return ModelSourceConfig(**base)


def test_client_gets_host_port_and_plain_http_from_an_http_url() -> None:
    with patch("minio.Minio") as mock_minio:
        mock_minio.return_value = MagicMock()
        _make_s3_client(_config("http://localhost:9000", s3_secure=True))
    args, kwargs = mock_minio.call_args
    assert args == ("localhost:9000",)
    assert kwargs["secure"] is False
    # Plain HTTP has no certificate to relax.
    assert "http_client" not in kwargs


def test_client_gets_tls_and_the_cert_relaxation_from_an_https_url() -> None:
    with patch("minio.Minio") as mock_minio:
        mock_minio.return_value = MagicMock()
        _make_s3_client(_config("https://minio.example", s3_secure=False, s3_cert_check=False))
    args, kwargs = mock_minio.call_args
    assert args == ("minio.example",)
    assert kwargs["secure"] is True
    assert kwargs["http_client"].connection_pool_kw["cert_reqs"] == "CERT_NONE"


def test_bare_host_port_still_follows_the_settings_flag() -> None:
    with patch("minio.Minio") as mock_minio:
        mock_minio.return_value = MagicMock()
        _make_s3_client(_config("minio.internal:9000", s3_secure=False))
    args, kwargs = mock_minio.call_args
    assert args == ("minio.internal:9000",)
    assert kwargs["secure"] is False


def test_url_with_a_path_never_reaches_the_client() -> None:
    with patch("minio.Minio") as mock_minio, pytest.raises(ModelSourceError):
        _make_s3_client(_config("http://localhost:9000/hope-models"))
    mock_minio.assert_not_called()

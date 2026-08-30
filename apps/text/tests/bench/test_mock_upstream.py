"""Unit tests for the Lane H2 (TASK-818) TLS mode additions to `mock_upstream.py`.

Deliberately outside `src/text/tests` — see `test_stats.py`'s docstring for why
this directory never runs as part of `pnpm text:test`. Run explicitly with:

    uv run --extra test python -m pytest apps/text/tests/bench -q --no-cov

Covers the pure logic only: cert generation (`ensure_self_signed_cert`), the
connection counter (`ConnectionCounter`), and env parsing (`MockConfig`). The
socket-level connection-counting hook itself (`_install_connection_counting`)
needs a real TCP/TLS listener to exercise meaningfully — that is proven by an
actual `--tls --connections-per-request` harness run (see `bench/README.md`
and the ticket report), not by a unit test here.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from mock_upstream import ConnectionCounter, MockConfig, ensure_self_signed_cert  # noqa: E402


class TestEnsureSelfSignedCert:
    def test_generates_a_pem_cert_and_key(self, tmp_path: Path) -> None:
        cert_path, key_path = ensure_self_signed_cert(tmp_path)

        assert cert_path == tmp_path / "bench-mock-cert.pem"
        assert key_path == tmp_path / "bench-mock-key.pem"
        assert cert_path.read_text().startswith("-----BEGIN CERTIFICATE-----")
        assert "PRIVATE KEY-----" in key_path.read_text()

    def test_is_idempotent_reuses_existing_files(self, tmp_path: Path) -> None:
        cert_path, key_path = ensure_self_signed_cert(tmp_path)
        first_cert_bytes = cert_path.read_bytes()
        first_key_bytes = key_path.read_bytes()

        cert_path_2, key_path_2 = ensure_self_signed_cert(tmp_path)

        assert cert_path_2 == cert_path
        assert key_path_2 == key_path
        assert cert_path.read_bytes() == first_cert_bytes
        assert key_path.read_bytes() == first_key_bytes

    def test_cert_is_valid_for_127_0_0_1(self, tmp_path: Path) -> None:
        from cryptography import x509
        from cryptography.x509.oid import ExtensionOID

        cert_path, _ = ensure_self_signed_cert(tmp_path)
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())

        san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        ip_names = [str(ip) for ip in san.get_values_for_type(x509.IPAddress)]
        assert "127.0.0.1" in ip_names

    def test_creates_cert_dir_if_missing(self, tmp_path: Path) -> None:
        nested = tmp_path / "does" / "not" / "exist"
        cert_path, key_path = ensure_self_signed_cert(nested)
        assert cert_path.exists()
        assert key_path.exists()


class TestConnectionCounter:
    def test_starts_at_zero(self) -> None:
        counter = ConnectionCounter()
        assert counter.count == 0

    def test_increment_counts_up(self) -> None:
        counter = ConnectionCounter()
        counter.increment()
        counter.increment()
        counter.increment()
        assert counter.count == 3

    def test_reset_zeroes_the_count(self) -> None:
        counter = ConnectionCounter()
        counter.increment()
        counter.increment()
        counter.reset()
        assert counter.count == 0


class TestMockConfigTlsFields:
    @pytest.fixture(autouse=True)
    def _clean_env(self) -> None:
        for key in ("BENCH_MOCK_TLS", "BENCH_MOCK_TLS_CERT_DIR"):
            os.environ.pop(key, None)
        yield
        for key in ("BENCH_MOCK_TLS", "BENCH_MOCK_TLS_CERT_DIR"):
            os.environ.pop(key, None)

    def test_tls_defaults_off_with_no_cert_dir(self) -> None:
        cfg = MockConfig.from_env()
        assert cfg.tls is False
        assert cfg.tls_cert_dir is None

    def test_tls_on_via_env(self) -> None:
        os.environ["BENCH_MOCK_TLS"] = "1"
        os.environ["BENCH_MOCK_TLS_CERT_DIR"] = "/tmp/some-dir"
        cfg = MockConfig.from_env()
        assert cfg.tls is True
        assert cfg.tls_cert_dir == "/tmp/some-dir"

    def test_tls_off_for_any_non_1_value(self) -> None:
        os.environ["BENCH_MOCK_TLS"] = "true"
        cfg = MockConfig.from_env()
        assert cfg.tls is False

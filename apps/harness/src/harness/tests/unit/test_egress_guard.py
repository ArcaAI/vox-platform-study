"""the SSRF egress guard, driven by the SHARED vector fixture.

This suite and ``packages/applications/src/common/egress/__tests__/egress-guard.test.ts``
load the SAME file (``tests/fixtures/egress-vectors.json``) and assert the same verdict
and the same reason code for every vector. That fixture is the only thing holding the two
hand-written implementations together — there is deliberately no shared runtime package —
so a rule changed on one side fails the other side's suite.

THIS side is the one that actually protects. The TypeScript half runs at admin WRITE time
and exists to give a human immediate feedback; DNS can change a second after the row is
saved, so the check that matters is the one performed here, immediately before the socket
is opened, on the address the socket will actually use.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.tools.egress_guard import evaluate_egress, is_blocked_address

_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[6] / "tests/fixtures/egress-vectors.json").read_text()
)
_DNS: dict[str, list[str]] = _FIXTURE["dns"]
_DEFAULT_ALLOWED: list[str] = _FIXTURE["defaultAllowedHosts"]
_VECTORS: list[dict] = _FIXTURE["vectors"]


def _stub_resolver(hostname: str) -> list[str]:
    """The fixture's ``dns`` map; NXDOMAIN for anything absent."""
    return list(_DNS.get(hostname.lower(), []))


@pytest.mark.parametrize("vector", _VECTORS, ids=[v["id"] for v in _VECTORS])
def test_shared_vector_contract(vector: dict) -> None:
    allowed_hosts = vector.get("allowedHosts", _DEFAULT_ALLOWED)
    decision = evaluate_egress(vector["url"], allowed_hosts, _stub_resolver)

    expected_allow = vector["expect"] == "allow"
    assert decision.allowed is expected_allow, f"{vector['id']}: {vector.get('note', '')}"

    if expected_allow:
        assert decision.reason is None
        # An ALLOW must hand back the exact addresses it validated — that set is what
        # the caller is obliged to connect to (see the DNS-rebinding note in the guard).
        assert list(decision.pinned) == vector["pinned"], vector["id"]
    else:
        assert decision.reason == vector["reason"], vector["id"]


def test_fixture_is_not_silently_empty() -> None:
    assert len(_VECTORS) >= 46


# ── FAIL CLOSED ────────────────────────────────────────────────────────────────
# The allow-list is a SECURITY control read from the control plane, so "we could not
# read it" must deny. ``None`` is how the harness pull route reports an UNRESOLVED key
# (``EffectiveConfigSnapshot.setting()`` returns None for an absent block, an absent key,
# a stored null, or a malformed entry), and it is deliberately a DIFFERENT reason code
# from an empty list so the two are distinguishable in a log.


def test_none_allowlist_denies() -> None:
    decision = evaluate_egress("https://mcp.partner.example.com/mcp", None, _stub_resolver)
    assert decision.allowed is False
    assert decision.reason == "allowlist_unavailable"


@pytest.mark.parametrize(
    "malformed",
    ["mcp.partner.example.com", 42, {}, [1, 2], [None], object()],
)
def test_malformed_allowlist_denies(malformed: object) -> None:
    """A malformed control-plane value must never be coerced into 'allow everything'."""
    decision = evaluate_egress("https://mcp.partner.example.com/mcp", malformed, _stub_resolver)
    assert decision.allowed is False
    assert decision.reason == "allowlist_unavailable"


def test_resolver_failure_denies() -> None:
    """A DNS outage is never an allow."""

    def boom(_hostname: str) -> list[str]:
        raise OSError("SERVFAIL")

    decision = evaluate_egress(
        "https://mcp.partner.example.com/mcp", ["mcp.partner.example.com"], boom
    )
    assert decision.allowed is False
    assert decision.reason == "unresolvable"


# ── The address classifier ────────────────────────────────────────────────────
# Pinned directly as well as through the URL-level vectors, because this is the half
# that must never be bypassable.


@pytest.mark.parametrize(
    "address",
    [
        "169.254.169.254",  # link-local / cloud metadata
        "169.254.0.0",
        "169.254.255.255",
        "127.0.0.1",  # loopback (Vault)
        "127.255.255.255",
        "10.0.0.0",
        "10.255.255.255",
        "172.16.0.0",
        "172.31.255.255",
        "192.168.0.0",
        "192.168.255.255",
        "0.0.0.0",
        "100.64.0.0",  # CGNAT
        "224.0.0.1",  # multicast
        "255.255.255.255",  # broadcast
        "::1",
        "::",
        "fd00::1",  # ULA
        "fe80::1",  # link-local
        "::ffff:10.0.0.1",  # IPv4-mapped
        "::ffff:169.254.169.254",
        "64:ff9b::a9fe:a9fe",  # NAT64-embedded metadata
        "2002:0a00:0001::1",  # 6to4-embedded RFC1918
        "::ffff:0:169.254.169.254",  # RFC 2765 IPv4-TRANSLATED (::ffff:0:0:0/96)
        "64:ff9b:1::a9fe:a9fe",  # RFC 8215 local-use NAT64 prefix
        "2001:0:4136:e378:8000:63bf:3fff:fdd2",  # Teredo tunnel (2001::/32)
        "fec0::1",  # deprecated site-local
        "2606:4700::5efe:169.254.169.254",  # ISATAP interface id under a public prefix
    ],
)
def test_blocked_addresses(address: str) -> None:
    assert is_blocked_address(address) is True


@pytest.mark.parametrize(
    "address",
    [
        "203.0.113.10",  # TEST-NET-3 — must stay usable, unlike stdlib is_private
        "198.51.100.7",  # TEST-NET-2
        "8.8.8.8",
        "172.32.0.1",  # just ABOVE 172.16/12
        "172.15.255.255",  # just BELOW 172.16/12
        "11.0.0.1",
        "9.255.255.255",
        "169.253.255.255",
        "169.255.0.0",
        "2606:4700::1111",
        # 2001:db8::/32 is the DOCUMENTATION prefix, not Teredo (2001:0000::/32).
        # Pins that the Teredo block did not swallow the wider 2001::/16.
        "2001:db8::1",
    ],
)
def test_allowed_addresses(address: str) -> None:
    assert is_blocked_address(address) is False


@pytest.mark.parametrize(
    "junk", ["", "not-an-ip", "999.999.999.999", "10.0.0", "localhost", "0177.0.0.1"]
)
def test_unparseable_address_is_blocked(junk: str) -> None:
    """'I could not tell' must mean 'no' on a security path."""
    assert is_blocked_address(junk) is True


def test_stdlib_is_private_is_deliberately_not_used() -> None:
    """A named anchor for the one surprising decision in this module.

    Python's ``ipaddress.is_private`` returns True for the TEST-NET documentation
    ranges. Had the guard leaned on it, every 'legitimate allowed host' vector in the
    shared fixture would be unreachable and the two implementations could not agree.
    The guard uses an explicit, auditable CIDR table instead.
    """
    import ipaddress

    assert ipaddress.ip_address("203.0.113.10").is_private is True
    assert is_blocked_address("203.0.113.10") is False

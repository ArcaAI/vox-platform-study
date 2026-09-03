"""SSRF egress guard for tenant-authored MCP connector URLs.

WHY THIS EXISTS. (OD-7) let tenant admins author McpServer.baseUrl, and this
worker connects to whatever that field says. Inside a k3s cluster an unconstrained URL
reaches the Kubernetes API, Vault on loopback, PgBouncer, and the cloud metadata endpoint
at 169.254.169.254 — server-side request forgery with a paying tenant as the attacker.

THIS IS THE HALF THAT PROTECTS. The TypeScript twin
(``packages/applications/src/common/egress/egress-guard.ts``) runs at admin write time and
exists to give a human immediate feedback. It cannot be the protection, because DNS can
change a second after the row is saved. The check that matters is the one performed here,
immediately before the socket is opened, on the address the socket will actually use.

The two are independent hand-written implementations held together by
``tests/fixtures/egress-vectors.json``, which both test suites load. A new rule goes in
the fixture first.

FOUR PROPERTIES THIS MODULE IS OBLIGED TO HAVE:

1. ALLOW-LIST, DENY-BY-DEFAULT. Never a deny-list — a deny-list loses to the first
   encoding trick, and the trick only has to work once.

2. THE RESOLVED ADDRESS IS WHAT IS VALIDATED, not the hostname string.
   ``evil.example.com`` resolving to ``10.0.0.5`` passes any string check ever written.
   :func:`evaluate_egress` therefore returns the exact addresses it validated in
   ``pinned``, and THE CALLER IS OBLIGED TO CONNECT TO THOSE. Validating a name and then
   letting the socket layer re-resolve it is the classic DNS-rebinding TOCTOU: the
   attacker answers the first lookup with a public address and the second with
   169.254.169.254. ``egress_transport.PinnedEgressTransport`` is what closes it here.

3. ANY blocked address in a multi-address answer denies the WHOLE url. Allowing the
   "good" address of a split answer just invites the attacker to race the connect.

4. FAIL CLOSED. An unresolvable allow-list, a malformed control-plane value, a DNS
   failure and an unparseable IP all DENY. There is no path through this module where
   "we could not check" becomes "allowed" — which is why :func:`is_blocked_address`
   returns ``True`` for junk rather than raising.

EXPLICIT CIDRs, NOT ``ipaddress.is_private``. The blocked set below is written out so a
reviewer can audit it against RFC 1918/3927/4193/6598 line by line, and because Python's
``is_private`` ALSO covers the TEST-NET documentation ranges (192.0.2.0/24,
198.51.100.0/24, 203.0.113.0/24). Leaning on it would make every "legitimate allowed
host" vector in the shared fixture unreachable, and the two implementations could not
agree on a table only one of them states.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from urllib.parse import urlsplit

#: A resolver: hostname -> its addresses. Injected so tests need no DNS.
HostResolver = Callable[[str], Sequence[str]]

#: IPv4 ranges that must never be reachable from a tenant-authored URL.
_BLOCKED_IPV4 = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "0.0.0.0/8",  # "this network" — reaches localhost on many stacks
        "10.0.0.0/8",  # RFC 1918
        "100.64.0.0/10",  # RFC 6598 CGNAT — routable inside cloud/cluster fabrics
        "127.0.0.0/8",  # loopback — Vault, PgBouncer, sidecars
        "169.254.0.0/16",  # RFC 3927 link-local — THE cloud metadata endpoint
        "172.16.0.0/12",  # RFC 1918
        "192.0.0.0/24",  # IETF protocol assignments
        "192.168.0.0/16",  # RFC 1918
        "198.18.0.0/15",  # RFC 2544 benchmarking
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved, incl. 255.255.255.255 broadcast
    )
)

#: IPv6 ranges blocked outright (embedded-IPv4 forms are unwrapped separately).
#:
#: TWO of these are TRANSITION prefixes blocked WHOLE rather than unwrapped, which is a
#: deliberate departure from the unwrap-and-recheck treatment given to the forms in
#: :func:`_embedded_ipv4`:
#:
#: * ``2001::/32`` (Teredo). Unwrapping does not work here. The canonical Teredo test
#Address ``2001:0:4136:e378:8000:63bf:3fff:fdd2`` embeds server 65.54.227.120 and
#Client 192.0.2.45 — both OUTSIDE the blocked IPv4 table — so an unwrap-only rule
#Would still allow it. The address is an IPv6-over-UDP tunnel that reaches whatever
#Its far end reaches, so the prefix itself is what must be refused.
#: * ``64:ff9b:1::/48`` (RFC 8215 local-use NAT64). RFC 6052 permits /32../96 embeddings
#Underneath it, so the IPv4 is not reliably the last 32 bits; and a LOCAL-USE
#Translation prefix is never a legitimate destination for a tenant connector.
#(The well-known ``64:ff9b::/96`` is /96-only and IS unwrapped, so a NAT64 route to a
#Public IPv4 still works.)
_BLOCKED_IPV6 = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "::/128",  # unspecified
        "::1/128",  # loopback
        "64:ff9b:1::/48",  # RFC 8215 local-use NAT64 — see the note above
        "100::/64",  # RFC 6666 discard-only
        "2001::/32",  # Teredo tunnelling — see the note above
        "fc00::/7",  # RFC 4193 unique-local
        "fe80::/10",  # link-local
        "fec0::/10",  # RFC 3879 site-local — deprecated is not the same as unroutable
        "ff00::/8",  # multicast
    )
)

_NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")

#: RFC 2765 IPv4-TRANSLATED. NOT the same prefix as IPv4-MAPPED (``::ffff:0:0/96``): the
#: 0xffff sits in bytes 8-9 instead of 10-11, so ``IPv6Address.ipv4_mapped`` is ``None``
#: for it and it needs its own branch.
_IPV4_TRANSLATED_PREFIX = ipaddress.ip_network("::ffff:0:0:0/96")

# ISATAP interface identifiers (RFC 5214 §6.1) — 00-00-5E-FE and its
#: globally-unique twin ``02-00-5E-FE``, followed by the embedded IPv4. The /64 prefix is
#: arbitrary (it can be public), so this is a pattern on bytes 8-11, not a network.
_ISATAP_INTERFACE_IDS = (b"\x00\x00\x5e\xfe", b"\x02\x00\x5e\xfe")

ALLOWED_SCHEMES = frozenset({"http", "https"})

# Reason codes. These strings are part of the cross-language contract — the shared
# fixture asserts them on BOTH sides, so renaming one here breaks the TypeScript suite.
REASON_ALLOWLIST_UNAVAILABLE = "allowlist_unavailable"
REASON_SCHEME_NOT_ALLOWED = "scheme_not_allowed"
REASON_USERINFO_NOT_ALLOWED = "userinfo_not_allowed"
REASON_HOST_NOT_ALLOWED = "host_not_allowed"
REASON_UNRESOLVABLE = "unresolvable"
REASON_BLOCKED_ADDRESS = "blocked_address"


@dataclass(frozen=True)
class EgressDecision:
    """The verdict for one URL, plus the addresses the caller must connect to."""

    allowed: bool
    #: The host ONLY — never the full URL. A connector URL can carry a token in its
    #: query string, and this value is written to logs on every rejection.
    host: str
    reason: str | None = None
    #: Operator-facing explanation; safe to log. Names no address the caller did not supply.
    detail: str | None = None
    #: The validated addresses. The caller MUST connect to these — see property (2).
    pinned: tuple[str, ...] = field(default_factory=tuple)


class EgressBlocked(Exception):
    """A tenant-authored URL was refused by the platform egress policy."""

    def __init__(self, decision: EgressDecision) -> None:
        super().__init__(decision.detail or "egress blocked")
        self.decision = decision
        self.reason = decision.reason
        self.host = decision.host


def _embedded_ipv4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """The IPv4 address embedded in an IPv6 one, or ``None``.

    Every one of these is a real bypass if left unwrapped: ``::ffff:169.254.169.254``,
    ``::ffff:0:169.254.169.254`` and ``64:ff9b::a9fe:a9fe`` all reach the metadata
    endpoint on a host whose netns routes the corresponding prefix.

    Transition prefixes whose IPv4 is NOT recoverable this way (Teredo) or not reliably
    in the last 32 bits (the RFC 8215 local-use NAT64 prefix) are blocked whole in
    :data:`_BLOCKED_IPV6` instead — see the note there.
    """
    if address.ipv4_mapped is not None:  # ::ffff:0:0/96
        return address.ipv4_mapped
    if address in _IPV4_TRANSLATED_PREFIX:  # ::ffff:0:0:0/96
        return ipaddress.IPv4Address(address.packed[12:16])
    if address in _NAT64_PREFIX:  # RFC 6052 well-known prefix
        return ipaddress.IPv4Address(address.packed[12:16])
    if address.sixtofour is not None:  # 2002::/16
        return address.sixtofour
    if address.packed[8:12] in _ISATAP_INTERFACE_IDS:  # <any /64>:0:5efe:a.b.c.d
        return ipaddress.IPv4Address(address.packed[12:16])
    # ::/96 — deprecated IPv4-compatible. `::` and `::1` are caught by _BLOCKED_IPV6 first.
    if address.packed[:12] == b"\x00" * 12:
        return ipaddress.IPv4Address(address.packed[12:16])
    return None


def is_blocked_address(address: str) -> bool:
    """Is this literal address in a range a tenant-authored URL must never reach?

    An UNPARSEABLE value returns ``True``. That is deliberate: this predicate sits on a
    security path, and "I could not tell" must mean "no".
    """
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return True

    if isinstance(parsed, ipaddress.IPv4Address):
        return any(parsed in net for net in _BLOCKED_IPV4)

    if any(parsed in net for net in _BLOCKED_IPV6):
        return True

    embedded = _embedded_ipv4(parsed)
    if embedded is not None:
        return any(embedded in net for net in _BLOCKED_IPV4)
    return False


def _canonical_address(value: str) -> str | None:
    """The comparable canonical form of an address literal, or ``None`` if not an IP."""
    try:
        return ipaddress.ip_address(value).compressed
    except ValueError:
        return None


def _host_allowed(host: str, allowed_hosts: Sequence[str]) -> bool:
    """Does ``host`` match the allow-list?

    An entry is either an exact host, or a leading-dot suffix (``.tools.example.org``)
    that matches that domain AND any subdomain of it. The leading dot is what makes the
    match LABEL-AWARE rather than a substring test: without it ``tools.example.org``
    would also match ``eviltools.example.org``, a registerable domain an attacker can own.

    An entry that is an IP LITERAL is compared by its parsed value, not its text, since
    the same IPv6 address has many spellings. That direction is a false DENIAL rather
    than a bypass — the address check still runs either way — but a security control
    nobody can configure correctly gets turned off.
    """
    host_address = _canonical_address(host)
    for raw in allowed_hosts:
        entry = raw.strip().lower()
        if not entry:
            continue
        if entry.startswith("."):
            if host == entry[1:] or host.endswith(entry):
                return True
            continue
        if host_address is not None:
            if _canonical_address(entry) == host_address:
                return True
            continue
        if host == entry:
            return True
    return False


def _deny(host: str, reason: str, detail: str) -> EgressDecision:
    return EgressDecision(allowed=False, host=host, reason=reason, detail=detail)


def default_resolver(hostname: str) -> list[str]:
    """Every A/AAAA answer for ``hostname``, de-duplicated, order preserved.

    BLOCKING — ``getaddrinfo`` hits the network. Async callers must run this off the
    event loop (``asyncio.to_thread``); ``mcp_client`` does.
    """
    infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    seen: dict[str, None] = {}
    for info in infos:
        # sockaddr is (host, port) for AF_INET and (host, port, flow, scope) for
        # AF_INET6; the first element is the address string in both.
        address = info[4][0]
        if isinstance(address, str):
            seen.setdefault(address, None)
    return list(seen)


def evaluate_egress(
    raw_url: str,
    allowed_hosts: object,
    resolve_host: HostResolver = default_resolver,
) -> EgressDecision:
    """Decide whether ``raw_url`` may be contacted, and with which addresses.

    ``allowed_hosts`` comes from the ``mcp.egress.allowedHosts`` registry key over the
    effective-config pull route. ``None`` (the control plane has no opinion — which is
    what ``EffectiveConfigSnapshot.setting()`` returns for an absent key, a stored null,
    or a malformed entry) and any non-``list[str]`` value DENY: an unreadable security
    control is never an open one.
    """
    if not isinstance(allowed_hosts, (list, tuple)) or not all(
        isinstance(entry, str) for entry in allowed_hosts
    ):
        return _deny(
            "",
            REASON_ALLOWLIST_UNAVAILABLE,
            "The platform egress allow-list (`mcp.egress.allowedHosts`) is unset or "
            "malformed. Outbound connectors are refused until a platform administrator "
            "configures it.",
        )

    try:
        parts = urlsplit(raw_url)
    except ValueError:
        return _deny("", REASON_SCHEME_NOT_ALLOWED, "The URL could not be parsed.")

    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        return _deny(
            "",
            REASON_SCHEME_NOT_ALLOWED,
            f"Scheme '{parts.scheme}' is not permitted; use http or https.",
        )

    # `urlsplit` raises ValueError on a malformed IPv6 literal / bad port.
    try:
        username, password, host = parts.username, parts.password, parts.hostname
    except ValueError:
        return _deny("", REASON_SCHEME_NOT_ALLOWED, "The URL could not be parsed.")

    if username or password:
        return _deny(
            "",
            REASON_USERINFO_NOT_ALLOWED,
            "Credentials embedded in the URL are not permitted.",
        )

    if not host:
        return _deny("", REASON_SCHEME_NOT_ALLOWED, "The URL has no host.")
    host = host.lower()

    if not _host_allowed(host, allowed_hosts):
        return _deny(
            host,
            REASON_HOST_NOT_ALLOWED,
            f"Host '{host}' is not on the platform egress allow-list.",
        )

    # A literal address needs no lookup — and must not get one, or we would validate a
    # different thing from the one we were given.
    if _canonical_address(host) is not None:
        addresses: list[str] = [host]
    else:
        try:
            addresses = list(resolve_host(host))
        except Exception:  # noqa: BLE001 — any resolver failure is a DENY, never an allow
            return _deny(
                host,
                REASON_UNRESOLVABLE,
                f"Host '{host}' could not be resolved, so its address could not be checked.",
            )
        if not addresses:
            return _deny(
                host,
                REASON_UNRESOLVABLE,
                f"Host '{host}' did not resolve to any address.",
            )

    # Property (3): ANY blocked address denies the whole URL.
    if any(is_blocked_address(address) for address in addresses):
        return _deny(
            host,
            REASON_BLOCKED_ADDRESS,
            f"Host '{host}' resolves to an address in a restricted range (private, "
            f"loopback, link-local/metadata, or multicast).",
        )

    return EgressDecision(allowed=True, host=host, pinned=tuple(addresses))

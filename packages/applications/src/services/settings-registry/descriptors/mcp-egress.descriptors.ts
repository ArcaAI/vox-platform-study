// TASK-846 D-3 — the platform egress allow-list for tenant-authored MCP connector URLs.
//
// WHAT THIS GOVERNS. TASK-846 (OD-7) let tenant admins author `McpServer.baseUrl`, which
// the harness worker then connects to. Unconstrained, that is SSRF with a tenant as the
// attacker: inside a k3s cluster the same field reaches the Kubernetes API, Vault on
// loopback, and the cloud metadata endpoint at 169.254.169.254. This key is the set of
// hosts a connector is permitted to reach.
//
// TIER: `global-kv`, and genuinely so. It is platform-wide, non-secret, and must take
// effect WITHOUT a redeploy — an allow-list you can only change by shipping an image is
// one nobody tightens during an incident. It is emphatically NOT an env var (env is the
// bootstrap floor: what is needed to reach the DB or authenticate to Vault) and NOT a new
// table (a per-tenant override would need one; D-3's recommendation, taken here, is to
// start platform-wide).
//
// SCOPE: `maxScope: 'system'` + `globalOnly: true`. This is the one place where a
// tenant-scoped value would defeat the control's whole purpose — the party the list
// constrains is the tenant, so a tenant that could write it could write itself
// `169.254.169.254`. It is the same shape as `security.password.*`: a floor the PLATFORM
// owes every tenant. `maxScope: 'system'` is also what makes `consumedBy` legitimate here
// (owner decision D-1: only a knob with no tenant opinion may ride the platform pull route).
//
// FAIL MODE: `closed`. This is the third fail-closed class alongside secrets and
// provider/model selection, and the reasoning is the same — an unresolved SECURITY control
// must never be substituted by a default, because the only default that could be
// substituted is "allow". Both consumers implement it: the write lane refuses the write,
// and the harness treats `snapshot.setting(...) is None` as DENY. The `default: []` below
// is therefore never used as a fallback (fail-closed means throw, not substitute) and is
// stated anyway so that even a future code path which DID consult it would deny
// everything rather than allow everything.
//
// WHY A LIST OF HOSTS AND NOT URLS. The value constrains reachability (which host may be
// contacted), not identity (which endpoint). Paths and ports are the connector row's
// business; the network boundary is the host.

import { SettingDescriptor } from '../registry.types';

export const MCP_EGRESS_ALLOWED_HOSTS_KEY = 'mcp.egress.allowedHosts';

export const MCP_EGRESS_SETTINGS: SettingDescriptor[] = [
  {
    key: MCP_EGRESS_ALLOWED_HOSTS_KEY,
    tier: 'global-kv',
    consumedBy: ['harness'],
    dataType: 'string[]',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'closed',
    category: 'Security',
    label: 'MCP connector egress allow-list (hosts)',
    description:
      'The hosts a tenant-authored MCP connector may be pointed at. An entry is either an exact hostname (`terminology.partner.example.com`) or a leading-dot suffix (`.partner.example.com`) that matches that domain and any subdomain of it. Deny-by-default: a host absent from this list is refused, and an EMPTY list refuses every connector. Matching the name is necessary but not sufficient — both the admin write path and the harness worker additionally resolve the host and refuse any answer in a private, loopback, link-local/metadata, CGNAT or multicast range, so an allow-listed name pointing at 10.0.0.5 is still blocked. Leave it empty until connectors are actually needed.',
    validate: (value: unknown) => {
      if (!Array.isArray(value)) return 'The egress allow-list must be an array of host strings.';
      for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim() === '') return 'Every allow-list entry must be a non-empty host string.';
        const host = entry.trim().toLowerCase();
        // A scheme, path, port, wildcard or userinfo here means the author expected URL
        // semantics this key does not have — refusing is honest; accepting would silently
        // never match and read as "the allow-list is broken".
        if (/[:/@?#]/.test(host) && !host.startsWith('[')) {
          return `Allow-list entry '${entry}' must be a bare host — no scheme, port, path, or credentials.`;
        }
        if (host.includes('*')) {
          return `Allow-list entry '${entry}' must not use '*'. Use a leading dot ('.example.com') to match subdomains.`;
        }
      }
      return undefined;
    },
    default: [],
  },
];

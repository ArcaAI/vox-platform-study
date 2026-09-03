// the injectable that binds the pure egress guard to the governed
// config tier and to real DNS.
//
// `egress-guard.ts` is deliberately pure (no DI, no I/O, no clock) so it can be driven
// by the shared vector fixture. This class is the thin adapter around it:
//
//   allow-list ← `mcp.egress.allowedHosts` (`global-kv`, read through AppSettings)
//   addresses ← `dns.lookup(all)`
//   verdict → `evaluateEgress`
//   denial → a 400 the admin can act on + one attributable WARN line
//
// FAIL CLOSED, everywhere. `mcp.egress.allowedHosts` declares `failMode: 'closed'`
// because a SECURITY control has only one default it could fall back to, and that
// default is "allow". Every read failure here therefore collapses to the same
// `null` the guard already treats as `allowlist_unavailable`:
//   • the key is unset → `getValueFromCache` returns null → deny
//   • the stored value is junk → not an array → deny
//   • the settings cache THROWS → caught, returned as null → deny
//   • DNS fails → the guard's `unresolvable` → deny
// Nothing in this file can turn any of those into an allow.
//
// WHY WRITE TIME AT ALL, given the harness re-checks at call time? Feedback. This is
// the only moment a human is present to be told "that host will never be reachable".
// It is explicitly NOT the protection: DNS can change a second after the row is saved,
// so the authoritative gate is `apps/harness/src/harness/tools/egress_guard.py`.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IAppSettingsService } from '../../services/baseServices/_meta/appSettings/IAppSettingsService';
import { evaluateEgress } from './egress-guard';

/**
 * The registry key holding the platform egress allow-list.
 *
 * Duplicated from `mcp-egress.descriptors.ts` rather than imported: `common/` must not
 * depend on `services/settings-registry/`, and `mcp-egress.descriptors.test.ts` asserts
 * the two are the same string, so the copy cannot drift silently.
 */
export const MCP_EGRESS_ALLOWED_HOSTS_KEY = 'mcp.egress.allowedHosts';

export interface EgressCheckContext {
  /** The tenant the write is attributed to — every rejection is logged against it. */
  tenantId?: string | null;
  actorUserId?: string | null;
}

@Injectable()
export class EgressPolicyService {
  private readonly logger = new Logger(EgressPolicyService.name);

  constructor(@Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService) {}

  /**
   * Throw unless `rawUrl` may be contacted under the platform egress policy.
   *
   * Resolves as a side effect of deciding — the guard validates the RESOLVED addresses,
   * never the hostname string, because `evil.example.com → 10.0.0.5` passes any string
   * check. This method deliberately DISCARDS the resolved addresses: at write time
   * nothing connects, and a pinned address recorded now would be stale by the time the
   * harness runs. Pinning belongs to the caller that actually opens the socket.
   */
  async assertUrlAllowed(rawUrl: string, context: EgressCheckContext = {}): Promise<void> {
    const decision = await evaluateEgress(rawUrl, this.readAllowList(), (hostname) => this.resolveHost(hostname));
    if (decision.allowed) return;

    // Attributable, but never the URL: a connector URL can carry a token in its query
    // string, and a rejection log that quoted it would BE the leak it is meant to catch.
    this.logger.warn('mcp.egress.rejected', {
      tenantId: context.tenantId ?? null,
      actorUserId: context.actorUserId ?? null,
      host: decision.host,
      reason: decision.reason,
    });

    throw new ArgumentInvalidException(decision.detail ?? 'The URL is not permitted by the platform egress policy.');
  }

  /**
   * The stored allow-list, or `null` for "unresolved" — which the guard denies on.
   *
   * `getValueFromCache` is the PLATFORM (SYSTEM-tier) accessor, which is the correct and
   * only correct one here: the key is `globalOnly` / `maxScope: 'system'`, and reading a
   * tenant override would let the party this control constrains widen it for itself.
   */
  private readAllowList(): string[] | null {
    try {
      const value = this.appSettings.getValueFromCache(MCP_EGRESS_ALLOWED_HOSTS_KEY);
      return Array.isArray(value) ? (value as string[]) : null;
    } catch {
      // A cache that is not yet warm, or a backend error, is NOT "no restrictions".
      return null;
    }
  }

  /** Every A/AAAA answer for `hostname`. `verbatim` keeps the resolver's own ordering. */
  private async resolveHost(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  }
}

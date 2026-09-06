/**
 * TASK-890 (OD-F/OD-K) — `@arcaai/vox` carries no admin-plane surface.
 *
 * Round 3 of TASK-890's discovery measured 212 `/admin/*` references over 22
 * distinct prefixes in `core/constants.ts`, consumed by 26 hook files with
 * ZERO first-party consumers (§2.7 #2 of the ticket README). This lane (L9)
 * removed the 25 admin hook files (`useUserSettings` stays — self-only,
 * `/users/me/settings`) and every admin-bearing constant group they alone
 * consumed, then inverted `isAdminPlanePath` from an impersonation-routing
 * predicate into a hard client-side refusal.
 *
 * Three `/admin/` string literals survive `core/constants.ts`, each because
 * deleting it would break a hook OUTSIDE this lane's ownership (documented
 * deviations in the L9 report, not silent scope creep):
 *   - `PIPELINE_ENDPOINTS` — `usePipelines`/`useArcaPipelines` are already
 *     `@deprecated TASK-865 — removed in R4`; that removal is TASK-865/901's
 *     job, not this lane's.
 *   - `POLICY_ENDPOINTS` — `usePolicies` was never in the 25-hook removal set.
 * `DEPARTMENT_ENDPOINTS.PROMPT_CONFIG` was a THIRD documented exception until
 * the wave-3 close measured it against the gateway: there is no
 * `GET admin/departments/:id/prompt-config` route (only the PATCH), so the two
 * `AgenticProvider` reads behind it had always 404'd into their own catch and
 * the DEF-C5 department tier had never applied. Constant and call sites are
 * removed; a self-scoped READ route is the follow-up.
 * The client-side refusal in `AgenticClient` still blocks any actual network
 * call through the two remaining paths for every OTHER caller — see the second
 * describe block below.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgenticClient } from '../core/AgenticClient';
import { AdminPlaneRefusedError, isAdminPlanePath } from '../core/constants';
import { mockFetch, createMockResponse, createMockLogger } from './setup';

const CONSTANTS_SRC = readFileSync(join(__dirname, '../core/constants.ts'), 'utf8');

function codeLines(src: string): string[] {
  return src.split('\n').filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/**');
  });
}

/** The two documented, out-of-lane exceptions (see the file header). */
const DOCUMENTED_ADMIN_PATH_PREFIXES = ['/admin/audio/pipelines', '/admin/rbac/policies'];

describe('business-plane only (TASK-890, OD-F/OD-K)', () => {
  describe('no undocumented /admin/ path survives in core/constants.ts', () => {
    it('every code line containing "/admin/" matches one of the three documented exceptions', () => {
      const adminLines = codeLines(CONSTANTS_SRC).filter((line) => line.includes('/admin/'));
      const undocumented = adminLines.filter((line) => !DOCUMENTED_ADMIN_PATH_PREFIXES.some((prefix) => line.includes(prefix)));
      expect(undocumented).toEqual([]);
    });

    it('the removed admin-bearing constant groups are gone', () => {
      const removedGroups = [
        'DNA_STYLE_ENDPOINTS',
        'PROMPT_TEMPLATE_ENDPOINTS',
        'TENANT_ENDPOINTS',
        'USER_ENDPOINTS',
        'ROLE_ENDPOINTS',
        'TENANT_BUCKET_ENDPOINTS',
        'GLOBAL_SETTINGS_ENDPOINTS',
        'API_KEY_ENDPOINTS',
        'QUEUE_ADMIN_ENDPOINTS',
        'AUDIT_LOG_ENDPOINTS',
        'ADMIN_USER_SETTINGS_ENDPOINTS',
        'ADMIN_USER_ROLES_ENDPOINTS',
        'ADMIN_USER_DEPARTMENTS_ENDPOINTS',
        'ADMIN_USER_PROFILE_ENDPOINTS',
        'TENANT_STORAGE_CONFIG_ENDPOINTS',
        'RATE_LIMIT_ADMIN_ENDPOINTS',
        'MONITORING_ENDPOINTS',
        'STORAGE_KEY_ENDPOINTS',
        'PLATFORM_METRICS_ENDPOINTS',
        'ADMIN_TRANSCRIPTION_JOB_ENDPOINTS',
        'ADMIN_CONSULTATION_ENDPOINTS',
        'TENANT_FRONTEND_CONFIG_ENDPOINTS',
        'PSTUDIO_ENDPOINTS',
        'SERVICE_HEALTH_ENDPOINTS',
        'HARNESS_ADMIN_ENDPOINTS',
      ];
      for (const name of removedGroups) {
        expect(CONSTANTS_SRC).not.toMatch(new RegExp(`export const ${name}\\b`));
      }
    });

    it('DEPARTMENT_ENDPOINTS is gone with its unreachable prompt-config read (wave-3 close)', () => {
      expect(CONSTANTS_SRC).not.toMatch(/export const DEPARTMENT_ENDPOINTS\b/);
      const providerSrc = readFileSync(join(__dirname, '../providers/AgenticProvider.tsx'), 'utf8');
      expect(providerSrc).not.toContain('DEPARTMENT_ENDPOINTS');
      // The provider must not reach an admin-plane path by any other spelling
      // either — `AgenticClient` would refuse it, and the refusal was being
      // swallowed by the cascade's own catch.
      expect(codeLines(providerSrc).filter((line) => line.includes("'/admin/") || line.includes('`/admin/'))).toEqual([]);
    });
  });

  describe('AgenticClient refuses an admin-plane request', () => {
    it('throws a named AdminPlaneRefusedError and makes no network call', async () => {
      const mockLogger = createMockLogger();
      const client = new AgenticClient({ baseUrl: 'https://api.example.com' }, mockLogger);
      mockFetch.mockClear();

      await expect(client.get('/admin/tenants')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('names the refused endpoint on the error', async () => {
      const mockLogger = createMockLogger();
      const client = new AgenticClient({ baseUrl: 'https://api.example.com' }, mockLogger);

      await expect(client.get('/admin/rbac/policies')).rejects.toThrow(/admin\/rbac\/policies/);
    });

    it('isAdminPlanePath still classifies the legacy /monitoring/* and /health/services surfaces', () => {
      expect(isAdminPlanePath('/monitoring/uptime')).toBe(true);
      expect(isAdminPlanePath('/health/services')).toBe(true);
      expect(isAdminPlanePath('/health/live')).toBe(false);
    });
  });
});

/**
 * TASK-760 — the business-plane URI normalization, locked at the SDK's
 * contract surface.
 *
 * `packages/agentic-sdk-v2/src/core/constants.ts` is the ONLY place the SDK
 * writes a gateway path, and it is a PUBLIC export — an integrator can import
 * these constants directly. Every literal below is therefore a wire contract,
 * and every change here is a MAJOR of the SDK family.
 *
 * The gateway answers **308** on the retired paths for one release
 * (`ALL-2.0.0` deletes the shims), so an un-upgraded consumer keeps working —
 * but the SDK itself must point at the new paths, not lean on the redirect.
 * The negative sweep at the bottom is what enforces that.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  ENTITLEMENTS_ENDPOINTS,
  MY_TENANT_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  TEXT_ENDPOINTS,
  USER_SETTINGS_ENDPOINTS,
  VOICE_EMBEDDING_ENDPOINTS,
} from '../constants';

describe('TASK-760 — user self plane moved into the plural `users` collection', () => {
  it('PERSONALIZATION_ENDPOINTS point at /users/me/preferences', () => {
    expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).toBe('/users/me/preferences');
    expect(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES).toBe('/users/me/preferences');
  });

  it('USER_SETTINGS_ENDPOINTS point at /users/me/settings', () => {
    expect(USER_SETTINGS_ENDPOINTS.list).toBe('/users/me/settings');
    expect(USER_SETTINGS_ENDPOINTS.updateByKey('display', 'theme')).toBe('/users/me/settings/display/theme');
  });

  it('still percent-encodes namespace/key so a `/` cannot forge a path segment', () => {
    expect(USER_SETTINGS_ENDPOINTS.updateByKey('a/b', 'c/d')).toBe('/users/me/settings/a%2Fb/c%2Fd');
  });
});

describe('TASK-760 — tenant self plane is `tenants/me/**`, NOT `users/me/**` (decision D-1)', () => {
  it('MY_TENANT_ENDPOINTS point at /tenants/me', () => {
    expect(MY_TENANT_ENDPOINTS.INFO).toBe('/tenants/me');
    expect(MY_TENANT_ENDPOINTS.CONFIG).toBe('/tenants/me/config');
    expect(MY_TENANT_ENDPOINTS.CONTEXT_SCHEMA).toBe('/tenants/me/context-schema');
  });

  it('the entitlements self-view folds into the TENANT alias — it is read:Tenant, not a user-owned resource', () => {
    expect(ENTITLEMENTS_ENDPOINTS.ME).toBe('/tenants/me/entitlements');
    expect(ENTITLEMENTS_ENDPOINTS.ME).not.toContain('/users/me');
  });
});

describe('TASK-760 — capability prefixes replace service names (decision D-2)', () => {
  it('TEXT_ENDPOINTS sit under text-generations, not the `text` service name', () => {
    expect(TEXT_ENDPOINTS.GENERATE).toBe('/text-generations/generate');
    expect(TEXT_ENDPOINTS.GENERATE_ASSEMBLED).toBe('/text-generations/generate/assembled');
    expect(TEXT_ENDPOINTS.PROVIDERS).toBe('/text-generations/providers');
    expect(TEXT_ENDPOINTS.TASK('t-1')).toBe('/text-generations/tasks/t-1');
    expect(TEXT_ENDPOINTS.TASK_CANCEL('t-1')).toBe('/text-generations/tasks/t-1/cancel');
    expect(TEXT_ENDPOINTS.TASK_STREAM('t-1')).toBe('/text-generations/tasks/t-1/stream');
  });

  it('task ids stay percent-encoded on the new prefix', () => {
    expect(TEXT_ENDPOINTS.TASK('a/b')).toBe(`/text-generations/tasks/${encodeURIComponent('a/b')}`);
  });
});

describe('TASK-760 — voice-profile is pluralized', () => {
  it('VOICE_EMBEDDING_ENDPOINTS point at /voice-profiles', () => {
    expect(VOICE_EMBEDDING_ENDPOINTS.enroll).toBe('/voice-profiles/enroll');
    expect(VOICE_EMBEDDING_ENDPOINTS.list).toBe('/voice-profiles');
    expect(VOICE_EMBEDDING_ENDPOINTS.delete('p-1')).toBe('/voice-profiles/p-1');
    expect(VOICE_EMBEDDING_ENDPOINTS.activate('p-1')).toBe('/voice-profiles/p-1/activate');
    expect(VOICE_EMBEDDING_ENDPOINTS.deactivate('p-1')).toBe('/voice-profiles/p-1/deactivate');
  });
});

describe('TASK-760 — no exported constant still carries a retired path', () => {
  const source = readFileSync(resolve(__dirname, '../constants.ts'), 'utf-8');
  const codeLines = source.split('\n').filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/**');
  });

  it.each([['/user/me/'], ['/voice-profile/'], ['/tenant/me/'], ['/rbac/check'], ['/entitlements/me'], ['/ai/nlp/'], ['/ai/guardrail/'], ["'/text/"], ['`/text/']])(
    'constants.ts contains no code line with %s',
    (retired) => {
      expect(codeLines.filter((line) => line.includes(retired))).toHaveLength(0);
    },
  );

  it("the `speech` prefix is deliberately UNCHANGED (decision D-3 — it is a capability, not the `apps/tts` service name)", () => {
    expect(codeLines.some((line) => line.includes("'/speech/synthesize'"))).toBe(true);
  });

  it('the frozen v1 compat prefix is untouched by this ticket', () => {
    expect(source).not.toContain('api/smr/api/v2');
  });
});

/**
 * TASK-957 F-9 (text-usage half) — one self-hosted set, not three.
 *
 * `resolveDeployment` used to carry its OWN copy of the self-hosted provider
 * ids. Identical copies are not the risk; DIVERGING copies are, and they had
 * already diverged: `SELF_HOSTED_PROVIDER_IDS` gained `harness` under TASK-959
 * §3.4 and this file's copy did not, so the same provider id classified
 * `SELF_HOSTED` in the ledger vocabulary and `CLOUD` here.
 *
 * The convergence is therefore pinned by EQUIVALENCE rather than by membership:
 * asserting a hard-coded list here would just be a fourth restatement. Every id
 * in the canonical `KNOWN_PROVIDERS` vocabulary — plus an id in NO vocabulary,
 * which a tenant admin can create at runtime — must get the same answer from
 * both functions, funded either way.
 */

import { describe, expect, it } from 'vitest';
import { AiDeploymentKind } from '@arcaai/domains';

import { KNOWN_PROVIDERS, classifyLlmDeployment } from '../../../usageLedger/vocabulary';
import { resolveDeployment } from '../text-usage';

describe('TASK-957 F-9 — resolveDeployment delegates to the ledger vocabulary', () => {
  const cases = [...KNOWN_PROVIDERS, 'a-provider-no-vocabulary-lists'];

  it.each(cases)('agrees with classifyLlmDeployment for %s (platform-funded)', (provider) => {
    expect(resolveDeployment(provider, false)).toBe(AiDeploymentKind[classifyLlmDeployment(provider, false)]);
  });

  it.each(cases)('agrees with classifyLlmDeployment for %s (tenant-funded)', (provider) => {
    expect(resolveDeployment(provider, true)).toBe(AiDeploymentKind[classifyLlmDeployment(provider, true)]);
  });

  it('classifies the harness worker id SELF_HOSTED — the id the two sets had already diverged on', () => {
    expect(resolveDeployment('harness', false)).toBe(AiDeploymentKind.SELF_HOSTED);
  });

  it('still lets funding win over the provider name', () => {
    expect(resolveDeployment('lm-studio', true)).toBe(AiDeploymentKind.BYOK);
    expect(resolveDeployment('openai', true)).toBe(AiDeploymentKind.BYOK);
  });
});

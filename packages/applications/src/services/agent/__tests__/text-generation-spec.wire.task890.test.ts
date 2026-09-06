/**
 * TASK-890 §3.1 / §2.7 #6 — what a TEXT candidate puts ON THE WIRE.
 *
 * Two facts change here, and both were live defects:
 *
 *  1. **`wireModelId`, not `sourceUri`.** `sourceUri` is the row's LOCATOR (a
 *     Hub repo, an `s3://` prefix) and `wireModelId` is the provider-native id;
 *     routing read the locator, so a row whose two differed put the wrong
 *     string on the wire. The seed said the repoint was planned and it never
 *     happened. A row with no `wireModelId` is not routable and drops out of
 *     the chain — exactly what a missing `sourceUri` used to mean.
 *
 *  2. **A tenant-declared model omits `deployment_name`.** For Azure,
 *     `azure_openai.py` prefers `override.deployment_name` over the request's
 *     `model`, so the CONNECTION's single deployment silently overrode whatever
 *     model the agent bound. A tenant-owned `AiModel` row IS a declared
 *     deployment (`providerClassOf` → `cloud-byo` by construction), so the
 *     candidate built from one drops that field and the agent's own model wins.
 *     The SYSTEM row keeps today's behaviour: there the connection's
 *     `deploymentName` names the platform deployment.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { toTextCandidate } from '../text-generation-spec';

const TENANT = 'tenant-aaa';

function agent(tenantId = TENANT): ResolvedAgent {
  return {
    slug: 'clinic-summariser',
    agentVersionId: 'ver-1',
    versionNumber: 3,
    tenantId,
    source: 'tenant',
    models: [],
    compiledConfig: { task: 'TEXT_GENERATION', service: 'llm', parameters: { temperature: 0.2 } },
  } as unknown as ResolvedAgent;
}

function model(over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel {
  return {
    role: 'primary',
    slug: 'azure-gpt-4o-mini',
    sourceUri: 'locator/only',
    sourceRevision: null,
    localPath: null,
    wireModelId: 'gpt-4o-mini',
    checksum: null,
    format: 'CLOUD_API',
    computeType: null,
    provider: 'azure',
    tenantId: TENANT,
    ...over,
  } as ResolvedAgentModel;
}

const OVERRIDE = { provider: 'azure', api_key: 'secret', funding: 'tenant' as const, base_url: 'https://acme.openai.azure.com', deployment_name: 'the-connection-deployment' };

describe('toTextCandidate — the routed id', () => {
  it('sends `wireModelId`, not the locator `sourceUri`', () => {
    const candidate = toTextCandidate(agent(), model(), 'primary', { fundingTier: 'tenant' });
    expect(candidate?.model).toBe('gpt-4o-mini');
  });

  it('drops a model with no `wireModelId` from the chain — it cannot be invoked', () => {
    expect(toTextCandidate(agent(), model({ wireModelId: null }), 'primary', { fundingTier: 'tenant' })).toBeNull();
    expect(toTextCandidate(agent(), model({ wireModelId: '  ' }), 'primary', { fundingTier: 'tenant' })).toBeNull();
  });
});

describe('toTextCandidate — the Azure deployment precedence', () => {
  it('a TENANT-declared model omits `deployment_name` so the agent-bound model reaches Azure', () => {
    const candidate = toTextCandidate(agent(), model({ tenantId: TENANT }), 'primary', {
      fundingTier: 'tenant',
      providerOverride: { ...OVERRIDE },
    });
    expect(candidate?.model).toBe('gpt-4o-mini');
    expect(candidate?.providerOverride).toBeDefined();
    expect(candidate?.providerOverride).not.toHaveProperty('deployment_name');
    // Everything else about the credential is untouched.
    expect(candidate?.providerOverride?.base_url).toBe('https://acme.openai.azure.com');
    expect(candidate?.providerOverride?.api_key).toBe('secret');
  });

  it('a SYSTEM catalogue row keeps the platform deployment name', () => {
    const candidate = toTextCandidate(agent(SYSTEM_TENANT_ID), model({ tenantId: SYSTEM_TENANT_ID }), 'primary', {
      fundingTier: 'platform',
      providerOverride: { ...OVERRIDE, funding: 'platform' },
    });
    expect(candidate?.providerOverride?.deployment_name).toBe('the-connection-deployment');
  });

  it('leaves a candidate with no override alone', () => {
    const candidate = toTextCandidate(agent(), model(), 'primary', { fundingTier: 'tenant' });
    expect(candidate?.providerOverride).toBeUndefined();
  });
});

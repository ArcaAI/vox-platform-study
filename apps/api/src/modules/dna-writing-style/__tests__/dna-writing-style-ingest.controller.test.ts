/**
 * TASK-974 §5.1 item 8 — `DnaWritingStyleIngestController`.
 *
 * The controller's ONE job is to say which credential is calling, and it cannot ask CLS: the
 * API-key path publishes `{ id, tenantId }` into CLS `user` with no roles and no key id
 * (`unified-auth.guard.apikey-principal-shape.test.ts` pins that shape as load-bearing), so an
 * API-key caller is indistinguishable there from a JWT caller with no roles. Everything else —
 * who the clinician is, whether the batch fits, whether DNA is on — is the service's.
 *
 * The boot-audit block at the bottom is the cheap version of a boot smoke: every audit that can
 * REFUSE STARTUP over a route declaration is run against this controller's real metadata, so a
 * missing scope or a missing `@ApiOperation` fails here rather than as a silent boot failure
 * nobody sees until the API will not come up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES, API_KEY_FORBIDDEN } from '@arcaai/applications';
import { auditEveryApiKeyReachableRouteDeclaresScopes } from '../../../bootstrap/api-key-surface-audit';
import { auditBusinessPlaneApiKeyExemptions } from '../../../bootstrap/business-plane-apikey-exemptions-audit';
import { auditServiceAccountReachableRoutesAreDeclared } from '../../../bootstrap/service-account-surface-audit';
import { DnaWritingStyleIngestController } from '../dna-writing-style-ingest.controller';

const dnaService = { ingestWritingSamples: vi.fn() };
const queue = { getJob: vi.fn() };

function make(): DnaWritingStyleIngestController {
  return new DnaWritingStyleIngestController(dnaService as never, queue as never);
}

const items = [{ text: 'Note.', writtenAt: '2026-09-01T09:00:00.000Z' }];

/** A request as the auth chain leaves it: at most one of the three principals is set. */
const request = (over: Record<string, unknown> = {}) => ({ headers: {}, params: {}, ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  dnaService.ingestWritingSamples.mockResolvedValue({
    jobId: 'job-1',
    status: 'PENDING',
    clinicianUserId: 'doctor-1',
    acceptedItems: 1,
    window: { from: '2026-09-01T09:00:00.000Z', to: '2026-09-01T09:00:00.000Z' },
  });
});

describe('which credential is calling', () => {
  it('a JWT caller is identified by their USER id', async () => {
    await make().ingest({ items }, request({ user: { id: 'doctor-1', tenantId: 't-1' } }));

    expect(dnaService.ingestWritingSamples).toHaveBeenCalledWith({ items }, { credentialClass: 'jwt', principalId: 'doctor-1' });
  });

  it('an API-key caller is identified by the KEY, not by the user it is bound to', async () => {
    await make().ingest({ items }, request({ apiKey: { id: 'key-1', tenantId: 't-1', userId: 'doctor-1' }, user: { id: 'doctor-1' } }));

    expect(dnaService.ingestWritingSamples).toHaveBeenCalledWith({ items }, { credentialClass: 'api-key', principalId: 'key-1' });
  });

  it('a service-account caller is identified by the ACCOUNT', async () => {
    await make().ingest({ items }, request({ serviceAccount: { id: 'svc-1', workingTenantId: 't-1' } }));

    expect(dnaService.ingestWritingSamples).toHaveBeenCalledWith({ items }, { credentialClass: 'service-account', principalId: 'svc-1' });
  });

  it('returns the service`s 202 body verbatim — the controller adds nothing', async () => {
    const result = await make().ingest({ items }, request({ user: { id: 'doctor-1' } }));

    expect(result).toEqual({
      jobId: 'job-1',
      status: 'PENDING',
      clinicianUserId: 'doctor-1',
      acceptedItems: 1,
      window: { from: '2026-09-01T09:00:00.000Z', to: '2026-09-01T09:00:00.000Z' },
    });
  });
});

describe('the job-status read carries the right identity into the gate', () => {
  const job = (data: unknown) => ({
    id: 'job-1',
    data,
    progress: 100,
    returnvalue: { reportId: 'r-1' },
    failedReason: undefined,
    getState: async () => 'completed',
  });

  it('a human reads their own job', async () => {
    queue.getJob.mockResolvedValue(job({ tenantId: 't-1', doctorId: 'doctor-1', userId: 'doctor-1' }));

    const status = await make().getIngestJob('job-1', request({ user: { id: 'doctor-1', tenantId: 't-1' } }));

    expect(status.status).toBe('completed');
  });

  it('a machine reads back the job ITS credential enqueued', async () => {
    queue.getJob.mockResolvedValue(
      job({ tenantId: 't-1', doctorId: 'doctor-1', userId: 'doctor-1', requestedBy: { credentialClass: 'service-account', principalId: 'svc-1' } }),
    );

    const status = await make().getIngestJob('job-1', request({ serviceAccount: { id: 'svc-1', workingTenantId: 't-1' } }));

    expect(status.status).toBe('completed');
  });

  it('a machine does NOT read a job another credential enqueued, even in its own tenant', async () => {
    queue.getJob.mockResolvedValue(
      job({ tenantId: 't-1', doctorId: 'doctor-1', userId: 'doctor-1', requestedBy: { credentialClass: 'api-key', principalId: 'key-9' } }),
    );

    await expect(make().getIngestJob('job-1', request({ serviceAccount: { id: 'svc-1', workingTenantId: 't-1' } }))).rejects.toThrow(/not found/i);
  });

  it('a machine does NOT inherit the tenant-wide ADMIN branch by having no doctorId', async () => {
    // The admin surface is "no doctorId declared". A machine also has none, so the machine gate
    // has to be selected explicitly — this is the case that would otherwise hand a scoped
    // integration every clinician's job in its tenant.
    queue.getJob.mockResolvedValue(job({ tenantId: 't-1', doctorId: 'someone-else', userId: 'someone-else' }));

    await expect(make().getIngestJob('job-1', request({ apiKey: { id: 'key-1', tenantId: 't-1' } }))).rejects.toThrow(/not found/i);
  });
});

describe('route declarations (the boot audits that can refuse startup)', () => {
  function fakeApp(controllers: Array<new (...args: never[]) => unknown>) {
    const wrappers = controllers.map((ControllerClass) => ({ metatype: ControllerClass, instance: Object.create(ControllerClass.prototype) }));
    const modulesContainer = new Map([['synthetic', { controllers: new Map(wrappers.map((w, i) => [String(i), w])) }]]);
    const reflector = new Reflector();
    return {
      get(token: unknown) {
        if (token === ModulesContainer) return modulesContainer;
        if (token === Reflector) return reflector;
        throw new Error('unexpected token');
      },
    } as never;
  }

  it('passes every audit that judges an API-key- and machine-reachable business route', () => {
    const app = fakeApp([DnaWritingStyleIngestController]);
    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(app)).not.toThrow();
    expect(() => auditBusinessPlaneApiKeyExemptions(app)).not.toThrow();
    expect(() => auditServiceAccountReachableRoutesAreDeclared(app)).not.toThrow();
  });

  it('declares both machine scopes at class level, and does NOT forbid API keys', () => {
    const reflector = new Reflector();
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, DnaWritingStyleIngestController)).toEqual(['dna-writing-style:ingest']);
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, DnaWritingStyleIngestController)).toEqual(['svc:dna-writing-style:ingest']);
    // D-4: the PERSONAL controller keeps its exemption; this one is the machine-reachable half.
    expect(reflector.get(API_KEY_FORBIDDEN, DnaWritingStyleIngestController)).toBeFalsy();
  });

  it('carries a BARE @Authorize() — the real gate is imperative, and a subject pair would lock clinicians out', () => {
    // `[]` (a bare `@Authorize()`) and `undefined` (no metadata at all) are NOT the same thing:
    // the first is a declaration that any authenticated principal may reach the route, which is
    // what keeps the deny-by-default boot audit green.
    expect(new Reflector().get(REQUIRED_PERMISSIONS_KEY, DnaWritingStyleIngestController)).toEqual([]);
  });
});

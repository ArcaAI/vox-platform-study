import 'reflect-metadata';
import { ForbiddenException, RequestMethod, SetMetadata } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

/**
 * TASK-1050 W2h — `admin/guardrail/{policy-keys,judge-models,judge-lanes,dry-run,metrics}`.
 *
 * The workspace `@arcaai/applications` resolves to a built `dist` that predates this lane, so the new services
 * and DTOs are taken from SOURCE and merged in. `svc:admin:guardrail:manage` is recorded as plain metadata until
 * `admin:guardrail:manage` is registered in `API_KEY_SCOPE_REGISTRY` (orchestrator follow-up); a registered scope
 * always goes through the real decorator, so this shim then does nothing.
 */
vi.mock('@arcaai/applications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const lane = await import('../../../../../../packages/applications/src/services/guardrail-policy');
  return {
    ...actual,
    ...lane,
    RequiredSvcScopes: (...scopes: string[]) =>
      scopes.every((scope) => actual.isValidServiceAccountScope(scope)) ? actual.RequiredSvcScopes(...scopes) : SetMetadata(actual.SERVICE_ACCOUNT_REQUIRED_SCOPES, scopes),
  };
});

import { API_KEY_FORBIDDEN, GuardrailMonitoringService, GuardrailPolicyService, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { API_TAGS } from '../../../openapi/tags';
import { GuardrailMetricsController } from '../guardrail-metrics.controller';
import { GuardrailPolicyController } from '../guardrail-policy.controller';

const API_RESPONSE_METADATA = 'swagger/apiResponse';
const API_OPERATION_METADATA = 'swagger/apiOperation';
const API_TAGS_METADATA = 'swagger/apiUseTags';
const REQUIRES_IF_MATCH = 'requiresIfMatch';
const NO_OCC = 'noOptimisticConcurrency';

type Proto = Record<string, (...args: unknown[]) => unknown>;
const policyProto = GuardrailPolicyController.prototype as unknown as Proto;
const metricsProto = GuardrailMetricsController.prototype as unknown as Proto;

const POLICY_ROUTES: Array<[string, RequestMethod, string, 'read' | 'update', 'if-match' | 'no-occ' | 'none']> = [
  ['list', RequestMethod.GET, 'policy-keys', 'read', 'none'],
  ['get', RequestMethod.GET, 'policy-keys/:key', 'read', 'none'],
  ['update', RequestMethod.PUT, 'policy-keys/:key', 'update', 'if-match'],
  ['resetLane', RequestMethod.POST, 'policy-keys/reset', 'update', 'no-occ'],
  ['reset', RequestMethod.POST, 'policy-keys/:key/reset', 'update', 'no-occ'],
  ['revisions', RequestMethod.GET, 'policy-keys/:key/revisions', 'read', 'none'],
  ['restore', RequestMethod.POST, 'policy-keys/:key/revisions/:revisionId/restore', 'update', 'no-occ'],
  ['updateJudgeMeta', RequestMethod.PUT, 'judge-models/:modelId/judge-meta', 'update', 'if-match'],
  ['resetJudgeMeta', RequestMethod.POST, 'judge-models/:modelId/judge-meta/reset', 'update', 'no-occ'],
  ['lanes', RequestMethod.GET, 'judge-lanes', 'read', 'none'],
  ['selectLanes', RequestMethod.PUT, 'judge-lanes', 'update', 'no-occ'],
  ['dryRun', RequestMethod.POST, 'dry-run', 'read', 'no-occ'],
];
const METRICS_ROUTES: Array<[string, string]> = [
  ['activity', 'activity'],
  ['performance', 'performance'],
  ['health', 'health'],
  ['evaluations', 'evaluations'],
];

describe('GuardrailPolicyController — the declarative layer', () => {
  it('mounts under admin/guardrail with exactly these routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GuardrailPolicyController)).toBe('admin/guardrail');
    for (const [handler, method, path] of POLICY_ROUTES) {
      expect(Reflect.getMetadata(METHOD_METADATA, policyProto[handler]), handler).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, policyProto[handler]), handler).toBe(path);
    }
    expect(Reflect.getMetadata(PATH_METADATA, GuardrailMetricsController)).toBe('admin/guardrail/metrics');
    for (const [handler, path] of METRICS_ROUTES) {
      expect(Reflect.getMetadata(METHOD_METADATA, metricsProto[handler]), handler).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(PATH_METADATA, metricsProto[handler]), handler).toBe(path);
    }
  });

  it('is admin-plane only: @ForbidApiKey, an AiModel CASL permission and the guardrail svc scope on every route', () => {
    const reflector = new Reflector();
    const all: Array<[Proto, unknown, string, 'read' | 'update']> = [
      ...POLICY_ROUTES.map(([handler, , , ability]) => [policyProto, GuardrailPolicyController, handler, ability] as [Proto, unknown, string, 'read' | 'update']),
      ...METRICS_ROUTES.map(([handler]) => [metricsProto, GuardrailMetricsController, handler, 'read'] as [Proto, unknown, string, 'read' | 'update']),
    ];
    for (const [proto, cls, handler, ability] of all) {
      const targets = [proto[handler], cls] as never;
      expect(reflector.getAllAndOverride(API_KEY_FORBIDDEN, targets), handler).toBe(true);
      expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, targets), handler).toEqual([{ action: ability, subject: 'AiModel' }]);
      expect(reflector.getAllAndOverride(SERVICE_ACCOUNT_REQUIRED_SCOPES, targets), handler).toEqual(['svc:admin:guardrail:manage']);
    }
  });

  it('the two PUTs that write one model row require If-Match; every other mutation names why it does not', () => {
    for (const [handler, , , , occ] of POLICY_ROUTES) {
      const ifMatch = Reflect.getMetadata(REQUIRES_IF_MATCH, policyProto[handler]) === true;
      const exempt = typeof Reflect.getMetadata(NO_OCC, policyProto[handler]) === 'string';
      expect(ifMatch, handler).toBe(occ === 'if-match');
      expect(exempt, handler).toBe(occ === 'no-occ');
    }
  });

  it('documents every route: a declared tag, a summary and a 403', () => {
    for (const cls of [GuardrailPolicyController, GuardrailMetricsController]) {
      const tags = Reflect.getMetadata(API_TAGS_METADATA, cls) as string[];
      for (const tag of tags) expect(API_TAGS.map((t) => t.name)).toContain(tag);
    }
    for (const [proto, handler] of [...POLICY_ROUTES.map(([h]) => [policyProto, h] as const), ...METRICS_ROUTES.map(([h]) => [metricsProto, h] as const)]) {
      expect((Reflect.getMetadata(API_OPERATION_METADATA, proto[handler]) as { summary?: string })?.summary, handler).toBeTruthy();
      expect(Object.keys(Reflect.getMetadata(API_RESPONSE_METADATA, proto[handler]) ?? {}), handler).toContain('403');
    }
  });

  it('If-Match wins over a body version', async () => {
    const service = { updatePolicyKey: vi.fn().mockResolvedValue({}), updateJudgeMeta: vi.fn().mockResolvedValue({}) };
    const controller = new GuardrailPolicyController(service as never);
    await controller.update('judgeTemperature', { value: 0.1, expectedVersion: 3 }, 7);
    expect(service.updatePolicyKey).toHaveBeenCalledWith('judgeTemperature', { value: 0.1, expectedVersion: 7 });
    await controller.updateJudgeMeta('m', { tiers: {}, expectedVersion: 1 }, 2);
    expect(service.updateJudgeMeta).toHaveBeenCalledWith('m', { tiers: {}, expectedVersion: 2 });
  });
});

describe('every route refuses a non-platform-admin with 403, through the REAL services', () => {
  const tenantAdminCls = { get: (k: string) => (k === 'user' ? { id: 'u', roles: ['TENANT_ADMIN'] } : k === 'tenantId' ? 'aaaaaaaa-0000-0000-0000-000000000001' : undefined) };
  const untouched = new Proxy({}, { get: () => vi.fn(() => Promise.reject(new Error('must not be reached'))) });
  const policyService = new (GuardrailPolicyService as any)(untouched, untouched, untouched, untouched, { available: true, specs: [], problems: [] }, { emit: vi.fn() }, tenantAdminCls);
  const monitoringService = new (GuardrailMonitoringService as any)(untouched, untouched, untouched, { emit: vi.fn() }, tenantAdminCls);
  const policy = new GuardrailPolicyController(policyService);
  const metrics = new GuardrailMetricsController(monitoringService);

  it.each([
    ['GET policy-keys', () => policy.list()],
    ['GET policy-keys/:key', () => policy.get('judgeTemperature')],
    ['PUT policy-keys/:key', () => policy.update('judgeTemperature', { value: 0.1 } as never, 7)],
    ['POST policy-keys/reset', () => policy.resetLane('guardrail.safety')],
    ['POST policy-keys/:key/reset', () => policy.reset('judgeTemperature')],
    ['GET policy-keys/:key/revisions', () => policy.revisions('judgeTemperature')],
    ['POST policy-keys/:key/revisions/:id/restore', () => policy.restore('judgeTemperature', 'r')],
    ['PUT judge-models/:id/judge-meta', () => policy.updateJudgeMeta('m', {} as never, 1)],
    ['POST judge-models/:id/judge-meta/reset', () => policy.resetJudgeMeta('m')],
    ['GET judge-lanes', () => policy.lanes()],
    ['PUT judge-lanes', () => policy.selectLanes({ selections: [] } as never)],
    ['POST dry-run', () => policy.dryRun({ lanes: ['injection_judge'], direction: 'inbound', samples: ['x'] } as never)],
    ['GET metrics/activity', () => metrics.activity({})],
    ['GET metrics/performance', () => metrics.performance()],
    ['GET metrics/health', () => metrics.health()],
    ['GET metrics/evaluations', () => metrics.evaluations({})],
  ])('%s → 403', async (_route, call) => {
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
  });
});

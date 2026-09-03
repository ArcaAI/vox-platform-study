/**
 * the redirect shims, exercised over real HTTP.
 *
 * The e2e spec (`tests/e2e/task-760-uri-normalization.spec.ts`) asserts the
 * same contract against a running gateway with the real guard chain. This
 * suite covers the half that does NOT need infrastructure: the status code,
 * the `Location` value, and the two things a hand-rolled redirect gets wrong —
 * dropping the query string, and dropping a path parameter.
 *
 * 308 is asserted exactly. "Some 3xx" would pass for a 302, and a 302 lets a
 * client rewrite POST into GET (RFC 7231 §6.4.3), silently dropping the
 * request body — which is the entire reason this ticket does not use one.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiInferenceRedirectShimController } from '../../modules/ai-inference/ai-inference-redirect.shim.controller';
import { MyBillingRedirectShimController } from '../../modules/billing/my-billing-redirect.shim.controller';
import { MyEntitlementsRedirectShimController } from '../../modules/entitlements/my-entitlements-redirect.shim.controller';
import { MyTenantContextSchemaRedirectShimController } from '../../modules/consultation-context-schema/consultation-context-schema-redirect.shim.controller';
import { MyTenantRedirectShimController } from '../../modules/tenant/my-tenant-redirect.shim.controller';
import { MyUsageRedirectShimController } from '../../modules/admin-usage/my-usage-redirect.shim.controller';
import { PermissionCheckRedirectShimController } from '../../modules/rbac/permission-check-redirect.shim.controller';
import { TextProxyRedirectShimController } from '../../modules/streaming/text-proxy-redirect.shim.controller';
import { UserMeRedirectShimController } from '../../modules/user/controllers/user-me-redirect.shim.controller';
import { VoiceProfileRedirectShimController } from '../../modules/voice-profile/voice-profile-redirect.shim.controller';

const CALLER_ID = '70000000-0000-0000-0000-000000000010';

describe(' redirect shims', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        UserMeRedirectShimController,
        MyTenantRedirectShimController,
        MyTenantContextSchemaRedirectShimController,
        MyBillingRedirectShimController,
        MyUsageRedirectShimController,
        MyEntitlementsRedirectShimController,
        VoiceProfileRedirectShimController,
        PermissionCheckRedirectShimController,
        AiInferenceRedirectShimController,
        TextProxyRedirectShimController,
      ],
      providers: [{ provide: ClsService, useValue: { get: () => ({ id: CALLER_ID }) } }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const cases: [string, 'get' | 'post' | 'patch' | 'delete', string, string][] = [
    ['user preferences', 'get', '/api/v1/user/me/preferences', '/api/v1/users/me/preferences'],
    ['user preferences (PATCH keeps its method)', 'patch', '/api/v1/user/me/preferences', '/api/v1/users/me/preferences'],
    ['user settings', 'get', '/api/v1/user/me/settings', '/api/v1/users/me/settings'],
    ['user departments', 'get', '/api/v1/user/me/departments', '/api/v1/users/me/departments'],
    ['tenant identity', 'get', '/api/v1/tenant/me', '/api/v1/tenants/me'],
    ['tenant config', 'get', '/api/v1/tenant/me/config', '/api/v1/tenants/me/config'],
    ['tenant config (PATCH)', 'patch', '/api/v1/tenant/me/config', '/api/v1/tenants/me/config'],
    ['tenant context schema', 'get', '/api/v1/tenant/me/context-schema', '/api/v1/tenants/me/context-schema'],
    ['entitlements', 'get', '/api/v1/entitlements/me', '/api/v1/tenants/me/entitlements'],
    ['invoices', 'get', '/api/v1/billing/me/invoices', '/api/v1/tenants/me/invoices'],
    ['spend', 'get', '/api/v1/billing/me/spend', '/api/v1/tenants/me/spend'],
    ['usage summary', 'get', '/api/v1/usage/me/summary', '/api/v1/tenants/me/usage-summary'],
    ['usage burndown', 'get', '/api/v1/usage/me/burndown', '/api/v1/tenants/me/usage-burndown'],
    ['voice profiles list', 'get', '/api/v1/voice-profile', '/api/v1/voice-profiles'],
    ['voice profile enrol', 'post', '/api/v1/voice-profile/enroll', '/api/v1/voice-profiles/enroll'],
    ['my permissions', 'post', '/api/v1/rbac/check/my-permissions', '/api/v1/users/me/permission-checks'],
    ['safety check', 'post', '/api/v1/ai/guardrail/analyze', '/api/v1/safety-checks'],
    ['ner', 'post', '/api/v1/ai/nlp/entities', '/api/v1/text-analyses/entities'],
    ['diagnosis', 'post', '/api/v1/ai/nlp/diagnosis', '/api/v1/text-analyses/diagnosis'],
    ['topic', 'post', '/api/v1/ai/nlp/topic', '/api/v1/text-analyses/topic'],
    ['intent', 'post', '/api/v1/ai/nlp/intent', '/api/v1/text-analyses/intent'],
    ['text generate', 'post', '/api/v1/text/generate', '/api/v1/text-generations/generate'],
    ['text generate assembled', 'post', '/api/v1/text/generate/assembled', '/api/v1/text-generations/generate/assembled'],
    ['text providers', 'get', '/api/v1/text/providers', '/api/v1/text-generations/providers'],
    ['text guardrail providers', 'get', '/api/v1/text/guardrail-providers', '/api/v1/text-generations/guardrail-providers'],
  ];

  it.each(cases)('%s: %s %s → 308 %s', async (_name, method, from, to) => {
    const response = await request(app.getHttpServer())[method](from);
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe(to);
  });

  it('never emits 301/302/307 — those let a client drop the request body', async () => {
    for (const [, method, from] of cases) {
      const response = await request(app.getHttpServer())[method](from);
      expect([301, 302, 307]).not.toContain(response.status);
    }
  });

  it('carries the query string across verbatim', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/tenant/me/context-schema?departmentId=dep-1&x=a%20b');
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/api/v1/tenants/me/context-schema?departmentId=dep-1&x=a%20b');
  });

  it('carries a path parameter across, percent-encoded', async () => {
    const response = await request(app.getHttpServer()).patch('/api/v1/voice-profile/vp%2F1/activate');
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/api/v1/voice-profiles/vp%2F1/activate');
  });

  it('carries the settings namespace/key pair across', async () => {
    const response = await request(app.getHttpServer()).patch('/api/v1/user/me/settings/ui.data-grid/users-list');
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/api/v1/users/me/settings/ui.data-grid/users-list');
  });

  it('resolves the CALLER into the by-id permission-check collection (the retired path carried no user in the URI)', async () => {
    const single = await request(app.getHttpServer()).post('/api/v1/rbac/check');
    expect(single.status).toBe(308);
    expect(single.headers.location).toBe(`/api/v1/users/${CALLER_ID}/permission-checks`);

    const bulk = await request(app.getHttpServer()).post('/api/v1/rbac/check/bulk');
    expect(bulk.status).toBe(308);
    expect(bulk.headers.location).toBe(`/api/v1/users/${CALLER_ID}/permission-checks/bulk`);
  });

  it('preserves the text task id on the SSE stream shim', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/text/tasks/t%201/stream');
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/api/v1/text-generations/tasks/t%201/stream');
  });
});

/**
 * RuleTester pins for `require-internal-tenant-header` (TASK-737 §4.4).
 *
 * The rule flags an outbound HTTP call to a downstream Python service whose
 * `headers` option carries `X-Service-Token` but no tenant channel. That exact
 * shape — a hand-rolled header literal with the service token and nothing else —
 * is what dropped `X-Tenant-Id` on nine separate `apps/api` → `apps/text` call
 * sites without a single review catching it.
 *
 * Sanctioned ways to satisfy it:
 *   - `headers: internalServiceHeaders({ ... })`     (the builder)
 *   - an explicit `'X-Tenant-Id'` / `TENANT_ID_HEADER` / `tenantHeaderValue(...)`
 *   - `'X-Internal-Tenant-Id'` (the STT↔gateway channel, §3.0 channel 2)
 */
'use strict';

const { RuleTester } = require('@arcaai/config-eslint/node_modules/eslint');
const rule = require('../rules/require-internal-tenant-header');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('require-internal-tenant-header', rule, {
  valid: [
    {
      name: 'the shared builder satisfies the rule',
      code: `
        const res = await this.httpService.axiosRef.post(url, body, {
          headers: internalServiceHeaders({ serviceToken, tenantId, tenantlessReason: TENANTLESS.JOB_QUEUE }),
        });
      `,
    },
    {
      name: 'an explicit X-Tenant-Id literal alongside the token satisfies the rule',
      code: `
        const res = await http.post(url, body, {
          headers: { 'Content-Type': 'application/json', 'X-Service-Token': token, 'X-Tenant-Id': tenantId },
        });
      `,
    },
    {
      name: 'the exported TENANT_ID_HEADER computed key satisfies the rule',
      code: `
        const res = await http.post(url, body, {
          headers: { 'X-Service-Token': token, [TENANT_ID_HEADER]: tenantHeaderValue(tenantId, TENANTLESS.CONTROL_PLANE) },
        });
      `,
    },
    {
      name: 'the STT X-Internal-Tenant-Id channel satisfies the rule',
      code: `
        const res = await http.post(url, body, {
          headers: { 'X-Service-Token': token, 'X-Internal-Tenant-Id': tenantId },
        });
      `,
    },
    {
      name: 'a spread of a sanctioned builder satisfies the rule',
      code: `
        const res = await http.get(url, {
          headers: { ...this.getForwardHeaders(), Accept: 'text/event-stream' },
        });
      `,
    },
    {
      name: 'a call with no service token is not an internal service hop',
      code: `const res = await http.post(url, body, { headers: { 'Content-Type': 'application/json' } });`,
    },
    {
      name: 'a plain object literal outside a request-options position is untouched',
      code: `const headers = { 'X-Service-Token': token };`,
    },
  ],

  invalid: [
    {
      name: 'axiosRef.post with a token-only header literal is flagged',
      code: `
        const res = await this.httpService.axiosRef.post(url, body, {
          timeout: 120000,
          headers: { 'Content-Type': 'application/json', 'X-Service-Token': textServiceToken },
        });
      `,
      errors: [{ messageId: 'missingTenantHeader' }],
    },
    {
      name: 'a GET stream with a token-only header literal is flagged',
      code: `
        const upstream = await this.httpService.axiosRef.get(url, {
          headers: { 'X-Service-Token': token, Accept: 'text/event-stream' },
        });
      `,
      errors: [{ messageId: 'missingTenantHeader' }],
    },
    {
      name: 'a conditionally-assigned tenant header does NOT satisfy the rule (absence must stay a defect)',
      code: `
        const headers = { 'Content-Type': 'application/json', 'X-Service-Token': token };
        const res = await http.post(url, body, { headers });
      `,
      errors: [{ messageId: 'missingTenantHeader' }],
    },
    {
      name: 'fetch-style options object is flagged too',
      code: `
        await fetch(url, { method: 'POST', headers: { 'X-Service-Token': token } });
      `,
      errors: [{ messageId: 'missingTenantHeader' }],
    },
  ],
});

console.log('require-internal-tenant-header: RuleTester passes (TASK-737 §4.4)');

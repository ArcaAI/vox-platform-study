/**
 * TASK-310 E-5 (AC-5) — RuleTester pins for
 * `no-direct-downstream-url-env`.
 *
 * The rule forbids direct `process.env.<DOWNSTREAM_URL_KEY>` reads
 * inside `apps/api/src/modules/**` so all downstream service URLs go
 * through the typed `IConfigService.getConfigValue(...)` accessor
 * (config-loading + validation happens once at bootstrap; modules
 * never re-read raw env at request time).
 *
 * Banned keys (the four downstream Python services + the legacy
 * SMR_SERVICE_URL alias):
 *   SMR_URL, SMR_SERVICE_URL, STT_V2_URL, TTS_URL, NLP_URL
 *
 * Everything else under `process.env.*` stays legal (NODE_ENV,
 * npm_package_version, etc.) so the rule is a tight denylist, not a
 * blanket process.env ban.
 */
'use strict';

const { RuleTester } = require('@arcaai/config-eslint/node_modules/eslint');
const rule = require('../rules/no-direct-downstream-url-env');

const ruleTester = new RuleTester({
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-direct-downstream-url-env', rule, {
  valid: [
    {
      name: 'reading the typed config service is allowed',
      code: `
        class Foo {
          constructor(cfg) { this.cfg = cfg; }
          base() { return this.cfg.getConfigValue('SMR_URL'); }
        }
      `,
    },
    {
      name: 'reading an unrelated env var (NODE_ENV) is allowed',
      code: `function fn() { return process.env.NODE_ENV; }`,
    },
    {
      name: 'reading an unrelated env var (npm_package_version) is allowed',
      code: `const v = process.env.npm_package_version;`,
    },
    {
      name: 'reading bracket-style with a non-banned key is allowed',
      code: `const v = process.env['DEBUG'];`,
    },
    {
      name: 'unrelated property access on a non-process object is allowed',
      code: `const url = config.env.SMR_URL;`,
    },
  ],

  invalid: [
    {
      name: 'process.env.SMR_URL (dot access) is flagged',
      code: `const url = process.env.SMR_URL || 'http://localhost:8862';`,
      errors: [{ messageId: 'directDownstreamUrlEnv', data: { name: 'SMR_URL' } }],
    },
    {
      name: 'process.env.SMR_SERVICE_URL (legacy alias) is flagged',
      code: `const url = process.env.SMR_SERVICE_URL;`,
      errors: [{ messageId: 'directDownstreamUrlEnv', data: { name: 'SMR_SERVICE_URL' } }],
    },
    {
      name: 'process.env.STT_V2_URL is flagged',
      code: `const url = process.env.STT_V2_URL || 'http://localhost:8861';`,
      errors: [{ messageId: 'directDownstreamUrlEnv', data: { name: 'STT_V2_URL' } }],
    },
    {
      name: 'process.env.TTS_URL is flagged',
      code: `const url = process.env.TTS_URL || 'http://localhost:8863';`,
      errors: [{ messageId: 'directDownstreamUrlEnv', data: { name: 'TTS_URL' } }],
    },
    {
      name: 'process.env.NLP_URL is flagged',
      code: `const url = process.env.NLP_URL || 'http://localhost:8864';`,
      errors: [{ messageId: 'directDownstreamUrlEnv', data: { name: 'NLP_URL' } }],
    },
    {
      name: 'bracket-style process.env["SMR_URL"] is flagged',
      code: `const url = process.env['SMR_URL'];`,
      errors: [{ messageId: 'directDownstreamUrlEnv', data: { name: 'SMR_URL' } }],
    },
  ],
});

// eslint-disable-next-line no-console
console.log('no-direct-downstream-url-env: RuleTester passes (TASK-310 E-5 / AC-5)');

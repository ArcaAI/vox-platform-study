/**
 * RuleTester pins for `require-api-key-justification` (TASK-761 gate G3,
 * justification half).
 *
 * ─── Why this is a LINT rule and not a boot audit ──────────────────────────
 *
 * G3's *presence* half — "every API-key-reachable route declares either
 * `@RequiredScopes(...)` or `@ForbidApiKey()`" — is resolved Nest metadata, so
 * it is a boot audit and already exists
 * (`apps/api/src/bootstrap/api-key-surface-audit.ts`, TASK-742). Its *value*
 * half on the business plane — "a `@ForbidApiKey()` there must be a named,
 * reasoned exemption" — is also metadata, and also already exists
 * (`business-plane-apikey-exemptions-audit.ts`, TASK-758).
 *
 * What neither can see is the REASON. A justification is a comment; comments
 * are erased by the TypeScript compiler long before any decorator metadata
 * exists, so no `Reflector` in any boot audit can ever read one. Source text is
 * exactly what ESLint sees, and only ESLint sees it. Hence: lint.
 *
 * ─── Marker choice (owner decision, 2026-08-18) ────────────────────────────
 *
 * `// API-KEY-NOTE` and `// AUTH-NOTE` stay DISTINCT and mean different things:
 * `API-KEY-NOTE` classifies the API-key posture of a surface; `AUTH-NOTE` is
 * the rule-05 marker for "the permission decorator understates the real gate".
 * This rule accepts `API-KEY-NOTE` ONLY. A rule accepting either would collapse
 * a distinction that answers two different questions — and there is no comment
 * migration: all four business-plane `@ForbidApiKey()` controllers in the tree
 * already carry `API-KEY-NOTE`, which the real-tree pin at the bottom proves.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { RuleTester, Linter } = require('@arcaai/config-eslint/node_modules/eslint');
// Subpath-with-dist because typescript-eslint's `exports` map has no folder
// entry, so Node cannot fold `.../typescript-eslint` to its main file the way
// it does for `eslint` above. Decorators are not parseable by espree at all,
// so a TS parser is not optional here.
const tsParser = require('@arcaai/config-eslint/node_modules/typescript-eslint/dist/index.js').parser;
const rule = require('../rules/require-api-key-justification');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('require-api-key-justification', rule, {
  valid: [
    {
      name: 'business-plane forbid carrying an API-KEY-NOTE with prose',
      code: `
        @Controller('voice-profile')
        // API-KEY-NOTE — REASONED EXEMPTION from policy A1: voice biometrics.
        // Enrolment audio IS a biometric identifier. JWT only.
        @ForbidApiKey()
        export class VoiceProfileController {}
      `,
    },
    {
      name: 'the note may sit above any decorator of the class, not only the forbid',
      code: `
        // API-KEY-NOTE — the credential-ISSUING plane; a key authenticating
        // itself here is circular. JWT only.
        @ApiTags('auth')
        @Controller('auth')
        @ForbidApiKey()
        export class AuthController {}
      `,
    },
    {
      name: 'the TASK-prefixed marker form is accepted',
      code: `
        @Controller('health')
        // TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER
        // CLASSIFICATION. Every route here is @Public().
        @ForbidApiKey()
        export class HealthController {}
      `,
    },
    {
      name: 'a block comment carrying the marker is accepted',
      code: `
        @Controller('billing')
        /**
         * API-KEY-NOTE — long-lived static credentials never read invoices.
         */
        @ForbidApiKey()
        export class MyBillingController {}
      `,
    },
    {
      name: 'admin-plane forbid needs no note — A2 is structural policy, not a per-controller judgement',
      code: `
        @Controller('admin/tenants')
        @ForbidApiKey()
        export class TenantController {}
      `,
    },
    {
      name: 'internal-plane forbid needs no note',
      code: `
        @Controller('internal/consent')
        @ForbidApiKey()
        export class ConsentInternalController {}
      `,
    },
    {
      name: 'a business controller declaring a scope is untouched',
      code: `
        @Controller('consultations')
        @RequiredScopes('consultation:read')
        export class ConsultationController {}
      `,
    },
    {
      name: 'a class with no @Controller is not a route surface',
      code: `
        @ForbidApiKey()
        export class SomeMixin {}
      `,
    },
    {
      name: 'a method-level forbid carrying its own note',
      code: `
        @Controller('usage')
        export class MyUsageController {
          @Get('export')
          // API-KEY-NOTE — bulk export is JWT-only; a static key must not
          // drain the whole usage ledger unattended.
          @ForbidApiKey()
          exportAll() {}
        }
      `,
    },
  ],

  invalid: [
    {
      name: 'business-plane forbid with no marker at all',
      code: `
        @Controller('voice-profile')
        @ForbidApiKey()
        export class VoiceProfileController {}
      `,
      errors: [{ messageId: 'missingApiKeyNote' }],
    },
    {
      name: 'a bare marker with no prose is not a justification',
      code: `
        @Controller('voice-profile')
        // API-KEY-NOTE
        @ForbidApiKey()
        export class VoiceProfileController {}
      `,
      errors: [{ messageId: 'emptyApiKeyNote' }],
    },
    {
      name: 'a marker followed only by punctuation is not a justification',
      code: `
        @Controller('voice-profile')
        // API-KEY-NOTE: —
        @ForbidApiKey()
        export class VoiceProfileController {}
      `,
      errors: [{ messageId: 'emptyApiKeyNote' }],
    },
    {
      name: 'AUTH-NOTE does NOT satisfy G3 — the two markers answer different questions',
      code: `
        @Controller('dna-writing-styles')
        // AUTH-NOTE: the owner/doctor check lives in the service, so the
        // class-level @Authorize() understates the real gate.
        @ForbidApiKey()
        export class DnaWritingStyleController {}
      `,
      errors: [{ messageId: 'missingApiKeyNote' }],
    },
    {
      name: 'a method-level forbid on a business controller with no note',
      code: `
        @Controller('usage')
        export class MyUsageController {
          @Get('export')
          @ForbidApiKey()
          exportAll() {}
        }
      `,
      errors: [{ messageId: 'missingApiKeyNote' }],
    },
    {
      name: 'a non-literal controller path fails closed — the plane cannot be proven, so the note is required',
      code: `
        @Controller(SOME_PREFIX)
        @ForbidApiKey()
        export class MysteryController {}
      `,
      errors: [{ messageId: 'missingApiKeyNote' }],
    },
  ],
});

/**
 * T-2 — the REAL-TREE pin, and the reason the owner decision costs nothing.
 *
 * Every business-plane controller that keeps `@ForbidApiKey()` today must lint
 * CLEAN under the `API-KEY-NOTE` marker. If this ever needed a comment
 * migration, this is the assertion that would have priced it; it does not.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUSINESS_PLANE_FORBID_FILES = [
  'apps/api/src/modules/auth/auth.controller.ts',
  'apps/api/src/modules/voice-profile/voice-profile.controller.ts',
  'apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts',
  'apps/api/src/modules/health/health.controller.ts',
];

const linter = new Linter();
for (const relative of BUSINESS_PLANE_FORBID_FILES) {
  const absolute = path.join(REPO_ROOT, relative);
  const source = fs.readFileSync(absolute, 'utf8');
  const allMessages = linter.verify(source, [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
      plugins: { 'arcaai-internal': { rules: { 'require-api-key-justification': rule } } },
      rules: { 'arcaai-internal/require-api-key-justification': 'error' },
    },
  ], absolute);

  // The real files carry `eslint-disable` comments for rules this minimal
  // config does not load ("Definition for rule ... was not found"); only this
  // rule's own reports are the subject of the pin.
  const messages = allMessages.filter((m) => m.ruleId === 'arcaai-internal/require-api-key-justification');

  if (messages.length > 0) {
    throw new Error(
      `require-api-key-justification: expected ${relative} to lint clean, got:\n` +
        messages.map((m) => `  line ${m.line}: ${m.message}`).join('\n'),
    );
  }
}

/**
 * The pin above is only worth having if the rule actually REACHES these files.
 * Strip the marker out of the real `auth.controller.ts` and the same run must
 * report — otherwise "lints clean" would be indistinguishable from "the rule
 * never fired".
 */
{
  const absolute = path.join(REPO_ROOT, 'apps/api/src/modules/auth/auth.controller.ts');
  const stripped = fs
    .readFileSync(absolute, 'utf8')
    .split('\n')
    .filter((line) => !line.includes('API-KEY-NOTE'))
    .join('\n');

  const reports = linter
    .verify(stripped, [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
        plugins: { 'arcaai-internal': { rules: { 'require-api-key-justification': rule } } },
        rules: { 'arcaai-internal/require-api-key-justification': 'error' },
      },
    ], absolute)
    .filter((m) => m.ruleId === 'arcaai-internal/require-api-key-justification');

  if (reports.length !== 1) {
    throw new Error(
      `require-api-key-justification: expected exactly 1 report on auth.controller.ts with the API-KEY-NOTE removed, got ${reports.length}`,
    );
  }
}

console.log(`require-api-key-justification: RuleTester passes; ${BUSINESS_PLANE_FORBID_FILES.length} real business-plane controllers lint clean (TASK-761 G3)`);

/**
 * TASK-310 E-5 (AC-5) — no-direct-downstream-url-env
 *
 * Forbids direct `process.env.<KEY>` reads for the downstream Python
 * service URLs inside `apps/api/src/modules/**`. All callsites must
 * resolve URLs via the typed `IConfigService.getConfigValue(...)`
 * (which loads-and-validates env once at bootstrap).
 *
 *   const url = process.env.SMR_URL || 'http://localhost:8862';   // ERROR
 *   const url = process.env['STT_URL'];                            // ERROR
 *   const url = process.env['STT_V2_URL'];                         // ERROR (dual-read window)
 *   const url = this.configService.getConfigValue('SMR_URL');     // OK
 *
 * The rule is a tight denylist on the known downstream URL keys —
 * other env reads (NODE_ENV, npm_package_version, ...) stay legal.
 * Scope is wired in `packages/config-eslint/flat/core.js` via a
 * config entry scoped to the modules glob, mirroring the
 * `no-controller-direct-prisma` precedent (W6.4).
 */
'use strict';

const BANNED_KEYS = new Set([
  'SMR_URL',
  'SMR_SERVICE_URL',
  'STT_URL',
  'STT_V2_URL',
  'NLP_URL',
  'GUARDRAIL_URL',
  'HARNESS_URL',
]);

function isProcessEnvBase(object) {
  if (!object || object.type !== 'MemberExpression') return false;
  if (object.computed) return false;
  if (!object.property || object.property.type !== 'Identifier' || object.property.name !== 'env') {
    return false;
  }
  if (!object.object || object.object.type !== 'Identifier' || object.object.name !== 'process') {
    return false;
  }
  return true;
}

function extractKey(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (!isProcessEnvBase(node.object)) return null;

  if (!node.computed) {
    if (node.property?.type === 'Identifier') {
      return node.property.name;
    }
    return null;
  }

  if (node.property?.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid `process.env.<DOWNSTREAM_URL_KEY>` reads. Use `IConfigService.getConfigValue(...)` (TASK-310 E-5 / AC-5).',
      recommended: true,
    },
    schema: [],
    messages: {
      directDownstreamUrlEnv:
        "Do not read `process.env.{{name}}` directly. Inject `IConfigService` and call `getConfigValue('{{name}}')` so the URL goes through bootstrap-time validation (TASK-310 E-5 / AC-5).",
    },
  },

  create(context) {
    return {
      MemberExpression(node) {
        const key = extractKey(node);
        if (key && BANNED_KEYS.has(key)) {
          context.report({
            node,
            messageId: 'directDownstreamUrlEnv',
            data: { name: key },
          });
        }
      },
    };
  },
};

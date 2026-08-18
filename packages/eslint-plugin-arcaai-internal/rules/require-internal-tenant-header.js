/**
 * require-internal-tenant-header  (TASK-737 §4.4)
 *
 * `X-Tenant-Id` is MANDATORY on every internal service-to-service request that
 * carries tenant-scoped work (owner directive 2026-08-16). An ABSENT header is a
 * defect in the CALLER — never something the callee papers over with a default,
 * because tenants may only TIGHTEN relative to SYSTEM, so resolving SYSTEM on a
 * dropped header silently downgrades a tenant that chose a stricter posture, with
 * nothing raised or logged anywhere.
 *
 * The propagation audit found NINE `apps/api` → `apps/text` call sites that never
 * even attempted to send it, several with a `tenantId` local in scope one line
 * above the HTTP call. Code review caught none of them. This rule is the backstop
 * that stops the tenth.
 *
 * ## What it flags
 *
 * An outbound HTTP request-options object whose `headers` carry `X-Service-Token`
 * (⇒ this is an internal service hop, not a third-party call) but no tenant
 * channel:
 *
 *     await http.post(url, body, {
 *       headers: { 'Content-Type': 'application/json', 'X-Service-Token': token }, // ERROR
 *     });
 *
 * ## How to satisfy it
 *
 *   - `headers: internalServiceHeaders({ serviceToken, tenantId, tenantlessReason })`
 *     — the sanctioned builder (`@arcaai/applications` `common/internal-service-headers`).
 *     Preferred: its `tenantlessReason` argument is REQUIRED, so there is no code
 *     path that omits the header.
 *   - an explicit `'X-Tenant-Id'` / `[TENANT_ID_HEADER]` key, or a
 *     `tenantHeaderValue(...)` call, for sites that must merge into an existing map.
 *   - `'X-Internal-Tenant-Id'` — the deliberate STT↔gateway channel (audit §3.0
 *     channel 2), which exists because a literal `X-Tenant-Id` from the
 *     single-credential STT worker would trip `ContextInterceptor`'s divergence 400.
 *
 * Genuinely tenant-less work DECLARES itself with `tenantless:<reason>` rather
 * than omitting the header — that is what keeps "absent" unambiguously a bug.
 *
 * Wired in `packages/config-eslint/flat/core.js`, mirroring the
 * `no-direct-downstream-url-env` precedent.
 */
'use strict';

/** Marks an options object as an INTERNAL service hop rather than a third-party call. */
const SERVICE_TOKEN_KEYS = new Set(['X-Service-Token', 'x-service-token']);

/** Any of these keys satisfies the rule (audit §3.0 declares two header channels). */
const TENANT_HEADER_KEYS = new Set([
  'X-Tenant-Id',
  'x-tenant-id',
  'X-Internal-Tenant-Id',
  'x-internal-tenant-id',
]);

/** Identifiers whose presence proves the tenant channel is populated by the contract. */
const SANCTIONED_IDENTIFIERS = new Set([
  'internalServiceHeaders',
  'tenantHeaderValue',
  'TENANT_ID_HEADER',
  'INTERNAL_TENANT_ID_HEADER',
]);

/** The property key of an object member, for string-literal, identifier and computed forms. */
function keyName(prop) {
  if (!prop || prop.type !== 'Property') return null;
  if (prop.computed) {
    // `[TENANT_ID_HEADER]: ...` — report the identifier so the caller below can
    // treat it as a sanctioned name.
    return prop.key?.type === 'Identifier' ? prop.key.name : null;
  }
  if (prop.key?.type === 'Identifier') return prop.key.name;
  if (prop.key?.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

/**
 * Resolve a `headers:` value to an ObjectExpression when it is one, following a
 * single level of variable indirection (`const headers = {...}; { headers }` —
 * the exact shape one of the audited call sites used).
 */
function resolveObject(node, scope) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') return node;
  if (node.type !== 'Identifier' || !scope) return null;

  let current = scope;
  while (current) {
    const variable = current.variables.find((v) => v.name === node.name);
    if (variable) {
      for (const def of variable.defs) {
        const init = def.node?.type === 'VariableDeclarator' ? def.node.init : null;
        if (init?.type === 'ObjectExpression') return init;
      }
      return null;
    }
    current = current.upper;
  }
  return null;
}

/**
 * True when the headers object (or anything reachable from it) already carries a
 * tenant channel. Deliberately permissive about SPREADS: `{ ...this.buildHeaders() }`
 * delegates to a helper this rule cannot see through, and flagging every such
 * delegation would train people to disable the rule rather than fix the call.
 * The contract test in `tests/contracts/internal-tenant-header.contract.test.ts`
 * covers the named helpers by file.
 */
function satisfiesTenantChannel(objectNode) {
  for (const prop of objectNode.properties) {
    if (prop.type === 'SpreadElement') return true;
    const name = keyName(prop);
    if (name && (TENANT_HEADER_KEYS.has(name) || SANCTIONED_IDENTIFIERS.has(name))) return true;
  }
  return false;
}

function carriesServiceToken(objectNode) {
  return objectNode.properties.some((prop) => {
    if (prop.type === 'SpreadElement') return false;
    const name = keyName(prop);
    return Boolean(name) && SERVICE_TOKEN_KEYS.has(name);
  });
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a tenant channel (`X-Tenant-Id` / `X-Internal-Tenant-Id`, or the `internalServiceHeaders()` builder) on every outbound internal service call that sends `X-Service-Token` (TASK-737).',
      recommended: true,
    },
    schema: [],
    messages: {
      missingTenantHeader:
        "This internal service call sends `X-Service-Token` but no tenant. `X-Tenant-Id` is MANDATORY on internal requests carrying tenant-scoped work (TASK-737): an absent header silently resolves the platform default provider and mis-attributes the spend. Build the headers with `internalServiceHeaders({ serviceToken, tenantId, tenantlessReason })` from `@arcaai/applications`, or set `X-Tenant-Id` explicitly. Genuinely tenant-less work must DECLARE itself with `tenantless:<reason>` rather than omit the header.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** Inspect one candidate request-options object. */
    function checkOptions(optionsNode) {
      if (!optionsNode || optionsNode.type !== 'ObjectExpression') return;

      const headersProp = optionsNode.properties.find(
        (prop) => prop.type === 'Property' && keyName(prop) === 'headers',
      );
      if (!headersProp) return;

      const scope = sourceCode.getScope
        ? sourceCode.getScope(headersProp.value)
        : context.getScope();
      const headersObject = resolveObject(headersProp.value, scope);

      // A non-literal `headers:` value (a builder call, a spread-only shorthand
      // the scope walk could not resolve) is out of this rule's reach; the
      // contract test covers those files by name.
      if (!headersObject) return;
      if (!carriesServiceToken(headersObject)) return;
      if (satisfiesTenantChannel(headersObject)) return;

      context.report({ node: headersProp, messageId: 'missingTenantHeader' });
    }

    return {
      CallExpression(node) {
        // Axios/HttpService: `post(url, body, options)` / `get(url, options)`;
        // fetch: `fetch(url, init)`. Rather than pattern-matching every client
        // shape, inspect every object-literal argument — the `X-Service-Token`
        // guard above is what makes this precise instead of noisy.
        for (const arg of node.arguments) {
          checkOptions(arg);
        }
      },
    };
  },
};

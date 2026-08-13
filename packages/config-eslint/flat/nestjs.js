/**
 * Flat preset for NestJS apps (`apps/api`).
 *
 * Exactly the shared core: NO `only-warn`, so the arcaai-internal
 * architecture rules (controller/service Prisma boundaries, downstream-URL
 * env guard, unscoped-client import ban) are HARD ERRORS here. This is the
 * severity contract documented in `.cursor/rules/01-development-workflow.mdc`.
 *
 * Note: the legacy eslintrc `nestjs.js` (relaxed no-explicit-any etc.) had
 * zero consumers — apps/api linted against plain `base.js` — so those
 * relaxations were deliberately NOT carried over.
*/
const core = require('./core');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [...core];

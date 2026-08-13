/**
 * eslint-plugin-arcaai-internal
 *
 * Local ESLint plugin packaging for arcaai's repo-internal lint rules.
 * Listed in `@arcaai/config-eslint`'s dependencies as `workspace:*`; the
 * flat presets (`flat/core.js`) register it as a plain object under the
 * `arcaai-internal` namespace, so rule IDs stay
 * `arcaai-internal/<rule>`.
 *
 * Add new rules by exporting them from this file's `rules` map. Each
 * rule lives in its own file under `./rules/`.
*/
'use strict';

module.exports = {
  // Flat-config plugin metadata (used by ESLint for error messages,
  // caching, and `--print-config` output).
  meta: {
    name: 'eslint-plugin-arcaai-internal',
    version: '1.0.0',
  },
  rules: {
    'no-controller-direct-prisma': require('./rules/no-controller-direct-prisma'),
    'no-direct-downstream-url-env': require('./rules/no-direct-downstream-url-env'),
  },
};

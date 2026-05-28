/**
 * TASK-307 W6.4 — eslint-plugin-arcaai-internal
 *
 * Local ESLint plugin packaging for arcaai's repo-internal lint rules.
 * Listed in `@arcaai/config-eslint`'s dependencies as `workspace:*` so
 * `base.js` can register it via the standard `plugins: ['arcaai-internal']`
 * string-name mechanism that legacy ESLint v8 config requires.
 *
 * Add new rules by exporting them from this file's `rules` map. Each
 * rule lives in its own file under `../rules/`.
 */
'use strict';

module.exports = {
  rules: {
    'no-controller-direct-prisma': require('./rules/no-controller-direct-prisma'),
    'no-direct-downstream-url-env': require('./rules/no-direct-downstream-url-env'),
  },
};

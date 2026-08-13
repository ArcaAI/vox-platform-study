/**
 * Flat preset for bundled React library packages — the flat successor of the
 * legacy eslintrc `react-internal.js`.
 *
 * Currently identical to `flat/library.js` (the legacy delta — browser env
 * carried no behavior because `no-undef` is never enabled; see library.js).
 * Kept as its own entry point so React-library-specific rules have a home
 * without touching every node library consumer.
 *
 * No consumers yet (the legacy react-internal.js had none either).
*/
const library = require('./library');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [...library];

/**
 * Flat preset for TypeScript library packages (`packages/*`) — the flat
 * successor of the legacy eslintrc `library.js` (TASK-418).
 *
 * core + `eslint-plugin-only-warn`: loading the plugin patches the running
 * ESLint's `Linter#verify` so every non-fatal error is downgraded to a
 * warning — architecture violations in packages surface as WARNINGS (treat
 * them as errors anyway; they are hard errors in apps/api via
 * `flat/nestjs.js`, which never loads this preset).
 *
 * The legacy `env: { node: true }` and `React`/`JSX` globals carried no
 * behavior: `no-undef` (the only rule globals feed) is disabled on TS files
 * by typescript-eslint's eslint-recommended and never enabled otherwise.
 * The globals are kept for documentation parity; the env is not.
 */
const onlyWarn = require('eslint-plugin-only-warn');

const core = require('./core');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
    ...core,
    {
        name: 'arcaai/library',
        plugins: {
            // No rules — registering the plugin (i.e. requiring it) is what
            // activates the error→warning downgrade for this lint process.
            'only-warn': onlyWarn,
        },
        languageOptions: {
            globals: {
                React: 'readonly',
                JSX: 'readonly',
            },
        },
    },
];

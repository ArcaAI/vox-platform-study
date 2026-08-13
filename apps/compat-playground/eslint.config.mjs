/**
 * ESLint flat config for the compat playground.
 *
 * Uses `@arcaai/config-eslint/flat/react-library.js` — the monorepo's React
 * preset. It fits: this is a bundled React/TypeScript surface
 * with no Next.js runtime, so `flat/next.js` (which registers the Next plugin
 * and its app-router rules) would be wrong, and `flat/nestjs.js` is for the API.
 *
 * Consequence worth knowing: the React preset spreads `flat/library.js`, which
 * loads `eslint-plugin-only-warn` — every finding surfaces as a WARNING. The
 * `lint` script therefore runs with `--max-warnings 0` (as `@arcaai/ui` and
 * `@arcaai/admin-console` do) so a warning still fails the gate.
*/
import reactLibrary from '@arcaai/config-eslint/flat/react-library.js';

export default [
  ...reactLibrary,
  {
    ignores: ['dist/**', 'node_modules/**', '.turbo/**'],
  },
];

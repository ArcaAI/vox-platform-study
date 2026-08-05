/**
 * Entry point for the `e2e-bundle` tsup build consumed by `e2e/fixtures/index.html`
 * (spec: `e2e/agentic-sdk.e2e.spec.ts`).
 *
 * WHY THIS FILE EXISTS INSTEAD OF POINTING THE E2E BUILD AT `src/index.ts`
 * ----------------------------------------------------------------------
 * `index.html` loads the bundle as a plain `<script type="module">` off a static
 * file server — no bundler, no import map. Every bare specifier the bundle still
 * carries is therefore unresolvable, and ONE of them is enough to stop the module
 * evaluating (`window.SDK` never gets set and every test dies in `beforeEach`).
 * The e2e build consequently inlines everything the browser cannot resolve on its
 * own — including `react`/`react-dom`, which the published builds keep external.
 *
 * React is re-exported here so the fixture page runs on exactly ONE React
 * instance. The page previously pulled React 18 UMD from unpkg (a network
 * dependency in a supposedly offline test) and, had the bundle simply inlined its
 * own copy, `AgenticProvider` would have mounted through the page's React while
 * calling hooks from the bundle's — the classic dual-React "invalid hook call".
 * `index.html` installs these on `window` before it uses them.
 */
export * from '../../src/index';

export { default as __React } from 'react';
export { createRoot as __createRoot } from 'react-dom/client';

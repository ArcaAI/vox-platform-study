import { defineConfig, type Options } from 'tsup';

/**
 * @arcaai/vox Build Configuration
 *
 * Multiple Entry Points Strategy:
 *
 * 1. Main build (index.ts): Full SDK with all plugins bundled
 *    - Imports: @arcaai/vox
 *
 * 2. Core build (core.ts): Lightweight SDK without plugin dependencies
 *    - Imports: @arcaai/vox/core
 *    - Use case: Admin apps, SSR, lazy-loading plugins
 *
 * 3. Plugins build (plugins.ts): Plugin hooks and pipelines only
 *    - Imports: @arcaai/vox/plugins
 *    - Use case: Lazy-loaded audio features (the SDK audio facade + TTS
 *      playback + the plugin/pipeline managers that drive backend STT)
 *
 * TASK-1006 (following TASK-865): the browser never runs a model. The
 * `@arcaai/vad`, `@arcaai/noise-filter` and `@arcaai/med-ner` client-AI
 * packages — and the `./plugins/med-ner` entry point that lazy-loaded the
 * last of them — were removed. What remains bundled is capture + the
 * backend streaming STT transport.
 *
 * Bundle Structure:
 * - Core: providers, hooks, state management, API client
 * - Bundled plugins:
 *   - @arcaai/room: Audio context management
 * - External plugins (own runtime assets via import.meta.url):
 *   - @arcaai/stt: capture + backend streaming STT transport (ships its own
 *     worklet)
 *
 * Optional (peer deps - not bundled):
 * - highlight.run: Observability integration
 * - @microsoft/clarity: Behavioural monitoring (non-production only — see ClarityTransport)
 *
 * Security Considerations:
 * - This SDK is a CLIENT-SIDE library and does NOT use React Server Components (RSC)
 * - The "use client" banner ensures components are client-side only
 * - React 18.3.0+ or 19.0.4+ is required for security patches (CVE-2025-55182)
 * - All bundled dependencies are workspace packages with controlled versioning
 * - External dependencies (react, react-dom) are not bundled to avoid version conflicts
 *
 * Bundle Security:
 * - Tree-shaking enabled to minimize attack surface
 * - Source maps generated for debugging (disable in production if needed)
 * - Browser-only platform target prevents Node.js module inclusion
 */

// Packages that should be bundled INTO the SDK (workspace dependencies).
//
// `@arcaai/stt` is NOT in this list — it is in `externalDependencies` below
// instead. It resolves a runtime asset via `new URL(<relative>,
// import.meta.url)` — the capture worklet — which esbuild breaks when it
// inlines that ESM sub-package: `import.meta` is shimmed to `{}`, so `new
// URL(rel, undefined)` throws "Invalid URL", and the `worklets/` file never
// lands in the SDK `dist/`. Keeping it external preserves `import.meta.url`
// and the co-located worklet asset in its own dist.
const bundledDependencies = ['@arcaai/json-schema-subset', '@arcaai/room', 'zustand', 'eventemitter3'];

// Core-only bundled dependencies (no plugin packages).
//
// `@arcaai/json-schema-subset` MUST be here as well as in `bundledDependencies`:
// the context-payload validator it backs is reached from `core` via
// `useArcaSession`/`useConsultationSchema`, and a workspace package left
// external stays a bare specifier that a consumer of the PUBLISHED
// `@arcaai/vox` cannot resolve. It is dependency-free and tiny, so inlining it
// costs the policed bundle nothing meaningful.
const coreBundledDependencies = ['@arcaai/json-schema-subset', 'zustand', 'eventemitter3'];

// Packages that consumers must install separately (true peer dependencies)
const externalDependencies = [
  'react',
  'react-dom',
  'highlight.run', // Optional - observability integration
  '@microsoft/clarity', // Optional - behavioural monitoring integration
  // Node.js-only packages that shouldn't be in browser bundles
  'onnxruntime-node',
  'sharp',
  // Asset-owning ESM sub-package MUST stay external (same class of reason as
  // documented above for `bundledDependencies`). `@arcaai/stt` resolves its
  // capture worklet via `new URL('../worklets/stt-capture.worklet.js',
  // import.meta.url)`. When bundled, esbuild inlines the source under an
  // `import_meta = {}` shim, so `new URL(rel, undefined)` throws "Invalid
  // URL", and the worklet never lands in the SDK `dist/`. External resolution
  // keeps `import.meta.url` + the co-located asset intact; it stays in
  // `package.json` `dependencies` so consumer bundlers (Vite/webpack) resolve
  // it normally.
  '@arcaai/stt',
];

// Plugin packages - external for core build, bundled for plugins build
const pluginPackages = ['@arcaai/room', '@arcaai/stt'];

// Shared build options
const sharedOptions: Partial<Options> = {
  // tsup's rollup DTS bundler chokes on the workspace packages' hook types, so
  // declarations are emitted by a chained `tsc --emitDeclarationOnly` step (see
  // the `build`/`build:dts` scripts) — `tsc --noEmit` passes cleanly, so this
  // ships correct, unbundled .d.ts for the `exports.types` entry points. Do NOT
  // set this true without also removing the tsc step.
  dts: false,
  splitting: false,
  sourcemap: true,
  treeshake: true,
  // Preserve "use client" directives for React Server Components compatibility
  banner: {
    js: '"use client";',
  },
  esbuildOptions(options) {
    options.platform = 'browser';
    options.conditions = ['browser', 'module', 'import', 'default'];
    // Mark optional imports as external to prevent build failures
    options.logOverride = {
      'import-is-undefined': 'silent',
    };
  },
};

export default defineConfig([
  // ==========================================================================
  // Main build - Full SDK with all plugins bundled
  // ==========================================================================
  {
    ...sharedOptions,
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    clean: true,
    external: externalDependencies,
    noExternal: bundledDependencies,
  },

  // ==========================================================================
  // Core build - Lightweight SDK without plugin dependencies
  // ==========================================================================
  {
    ...sharedOptions,
    entry: { core: 'src/core.ts' },
    format: ['cjs', 'esm'],
    outDir: 'dist',
    // External: peer deps + plugin packages (not bundled in core)
    external: [...externalDependencies, ...pluginPackages],
    noExternal: coreBundledDependencies,
  },

  // ==========================================================================
  // Plugins build - Plugin hooks and pipelines only
  // ==========================================================================
  {
    ...sharedOptions,
    entry: { plugins: 'src/plugins.ts' },
    format: ['cjs', 'esm'],
    outDir: 'dist',
    external: externalDependencies,
    noExternal: bundledDependencies,
  },

  // ==========================================================================
  // E2E build - browser fixture for e2e/agentic-sdk.e2e.spec.ts
  //
  // NOT "same as the main build": `e2e/fixtures/index.html` loads this file as a
  // bare `<script type="module">` off a static file server, with no bundler and
  // no import map behind it. Anything left external stays a bare specifier the
  // browser cannot resolve, and a single unresolved static import aborts module
  // evaluation — `window.SDK` never gets set and every test in the suite fails in
  // its shared `beforeEach`. So this entry inlines everything a browser cannot
  // resolve for itself, `react`/`react-dom` included (see `e2e/fixtures/e2e-entry.ts`).
  //
  // What deliberately stays external, and why it is safe here:
  //   - `highlight.run`, `@microsoft/clarity`, `onnxruntime-node`, `sharp`:
  //     reached only through `import()` on opt-in code paths this suite never
  //     enters.
  //
  // `@arcaai/stt` IS inlined here even though the published build keeps it
  // external for the `import.meta.url` hazard documented above: this entry is
  // esm-only, so esbuild leaves `import.meta.url` intact rather than shimming
  // it to `{}`. Its worklet asset still does not resolve next to the fixture
  // bundle — irrelevant, because the suite only asserts that `useArcaAudio` is
  // exported, never drives a live capture through it.
  // ==========================================================================
  {
    ...sharedOptions,
    entry: { 'e2e-bundle': 'e2e/fixtures/e2e-entry.ts' },
    format: ['esm'],
    outDir: 'e2e/fixtures/dist',
    external: externalDependencies,
    // NOTE: tsup gives `noExternal` precedence over `external`, so the entries
    // below win over `externalDependencies`. Sub-path imports are matched by
    // regex because tsup compares plain strings with `===` — `'react-dom'` would
    // not match `'react-dom/client'`, and `'react'` would not match
    // `'react/jsx-runtime'`.
    noExternal: [...bundledDependencies, /^react($|\/)/, /^react-dom($|\/)/, '@arcaai/stt', 'valibot', 'deepmerge-ts', 'diff'],
    // esbuild empties `import.meta` on targets below es2020; keeping a modern
    // target avoids that hazard for any future `import.meta.url` use in this
    // fixture's dependency graph.
    target: 'es2022',
  },
]);

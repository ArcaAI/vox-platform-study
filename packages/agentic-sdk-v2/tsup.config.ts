import { defineConfig, type Options } from 'tsup';

/**
 * @arcaai/vox Build Configuration
 *
 * Multiple Entry Points Strategy:
 *
 * 1. Main build (index.ts): Full SDK with all plugins bundled
 *    - Imports: @arcaai/vox
 *    - Size: ~5.2MB (includes STT, VAD, noise-filter, room)
 *
 * 2. Core build (core.ts): Lightweight SDK without plugin dependencies
 *    - Imports: @arcaai/vox/core
 *    - Size: ~200KB (providers, hooks, types, utilities)
 *    - Use case: Admin apps, SSR, lazy-loading plugins
 *
 * 3. Plugins build (plugins.ts): Plugin hooks and pipelines only
 *    - Imports: @arcaai/vox/plugins
 *    - Size: ~5MB (STT, VAD, noise-filter bundled)
 *    - Use case: Lazy-loaded audio features
 *
 * Bundle Structure:
 * - Core (~200KB): Provider, hooks, state management, API client
 * - Bundled plugins:
 *   - @arcaai/vad: Silero VAD wrapper (@ricky0123/vad-web + ONNX Runtime Web stay external)
 *   - @arcaai/room: Audio context management
 * - External plugins (own runtime assets via import.meta.url):
 *   - @arcaai/stt: Whisper + HuggingFace Transformers (ships its own Whisper worker)
 *   - @arcaai/noise-filter: RNNoise WASM (ships its own rnnoise.wasm)
 *
 * Optional (peer deps - not bundled):
 * - @arcaai/med-ner: Medical NER (~300MB models)
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
// `@arcaai/stt` and `@arcaai/noise-filter` are NOT in this list — they are in
// `externalDependencies` below instead. Both resolve runtime assets
// via `new URL(<relative>, import.meta.url)` — the Whisper worker and the
// RNNoise WASM — which esbuild breaks when it inlines those ESM sub-packages:
// `import.meta` is shimmed to `{}`, so `new URL(rel, undefined)` throws
// "Invalid URL", and the `workers/`/`assets/` files never land in the SDK
// `dist/`. Keeping them external preserves `import.meta.url` and the
// co-located worker/wasm assets in each sub-package's own dist.
const bundledDependencies = [
  '@arcaai/json-schema-subset',
  '@arcaai/room',
  '@arcaai/vad',
  'zustand',
  'eventemitter3',
];

// Core-only bundled dependencies (no plugin packages).
//
// `@arcaai/json-schema-subset` MUST be here as well as in `bundledDependencies`:
// the context-payload validator it backs is reached from `core` (and therefore
// `compat`) via `useArcaSession`/`useConsultationSchema`, and a workspace
// package left external stays a bare specifier that a consumer of the PUBLISHED
// `@arcaai/vox` cannot resolve. It is dependency-free and tiny, so inlining it
// costs the policed bundle nothing meaningful.
const coreBundledDependencies = ['@arcaai/json-schema-subset', 'zustand', 'eventemitter3'];

// Packages that consumers must install separately (true peer dependencies)
const externalDependencies = [
  'react',
  'react-dom',
  '@arcaai/med-ner', // Optional - heavy NER models, consumer opts-in
  'highlight.run', // Optional - observability integration
  '@microsoft/clarity', // Optional - behavioural monitoring integration
  // Node.js-only packages that shouldn't be in browser bundles
  'onnxruntime-node',
  'sharp',
  // ONNX Runtime Web + Silero VAD engine MUST stay external.
  //
  // `@ricky0123/vad-web@0.0.30` is a CJS-only package whose internal modules
  // do `require("onnxruntime-web")`. If we let tsup inline that CJS source
  // into vox's ESM bundle, esbuild emits a `__require()` stub for the
  // externalized `onnxruntime-web` import (sync CJS require → async ESM
  // import is not a valid transform). The stub throws
  // `Dynamic require of "onnxruntime-web" is not supported` at runtime in
  // browsers (where `require` is undefined).
  //
  // Solution: keep `@ricky0123/vad-web` external so the consumer's bundler
  // (Vite via @rollup/plugin-commonjs, webpack via its CJS interop) handles
  // the CJS→ESM conversion correctly. `onnxruntime-web` and
  // `onnxruntime-common` are listed explicitly (defensive: they are already
  // external by default because they live in `dependencies`, but the explicit
  // listing protects against accidental `noExternal` regressions and
  // documents the intent for future maintainers).
  //
  // ORT-web ships ESM in `onnxruntime-web@1.24.3/dist/esm/` plus WASM glue
  // `.mjs` files loaded via dynamic `import()`. It MUST stay external —
  // bundling it produces a 30MB+ artifact AND breaks WASM runtime discovery.
  '@ricky0123/vad-web',
  'onnxruntime-web',
  'onnxruntime-common',
  // Asset/worker-owning ESM sub-packages MUST stay external (same
  // class of reason as `@ricky0123/vad-web` above). `@arcaai/noise-filter`
  // resolves its RNNoise WASM via `new URL('../assets/rnnoise.wasm',
  // import.meta.url)` and `@arcaai/stt` spawns its Whisper worker via
  // `new Worker(new URL('./workers/whisper.worker.mjs', import.meta.url))`.
  // When bundled, esbuild inlines the source under an `import_meta = {}` shim,
  // so `new URL(rel, undefined)` throws "Invalid URL", and neither the worker
  // nor the wasm is copied into the SDK `dist/`. External resolution keeps
  // `import.meta.url` + the co-located assets intact. Both stay in `package.json`
  // `dependencies` so consumer bundlers (Vite/webpack) resolve them normally.
  '@arcaai/stt',
  '@arcaai/noise-filter',
];

// Plugin packages - external for core build, bundled for plugins build
const pluginPackages = ['@arcaai/room', '@arcaai/vad', '@arcaai/stt', '@arcaai/noise-filter'];

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
  // Compat build - v1-compatibility hooks. Light like `core`: no
  // plugin bundling (external plugin packages); only consumes the public v2 API.
  // ==========================================================================
  {
    ...sharedOptions,
    entry: { compat: 'src/compat.ts' },
    format: ['cjs', 'esm'],
    outDir: 'dist',
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
  // Plugins/med-ner build - Optional NER hook (separate to avoid loading
  // @arcaai/med-ner when consumers only import @arcaai/vox/plugins)
  // ==========================================================================
  {
    ...sharedOptions,
    entry: { 'plugins-med-ner': 'src/plugins-med-ner.ts' },
    format: ['cjs', 'esm'],
    outDir: 'dist',
    external: externalDependencies,
    noExternal: [],
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
  //   - `onnxruntime-web`/`-common`: bundling them yields a 30MB+ artifact AND
  //     breaks their WASM discovery (see the note in `externalDependencies`). The
  //     only importer is the inlined CJS `@ricky0123/vad-web`, whose
  //     `require("onnxruntime-web")` esbuild turns into a `__require()` stub —
  //     no bare import is emitted, so the module still evaluates. The stub throws
  //     only if VAD is actually instantiated, which this suite never does.
  //   - `@arcaai/med-ner`, `highlight.run`, `@microsoft/clarity`,
  //     `onnxruntime-node`, `sharp`: reached only through `import()` on opt-in
  //     code paths this suite never enters.
  //
  // `@arcaai/stt`/`@arcaai/noise-filter` ARE inlined here even though the published
  // builds keep them external for the `import.meta.url` hazard documented above:
  // this entry is esm-only, so esbuild leaves `import.meta.url` intact rather than
  // shimming it to `{}`. Their worker/WASM assets still do not resolve next to the
  // fixture bundle — irrelevant, because the suite only asserts that `useSTT` /
  // `useNoiseFilter` are exported, never runs them.
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
    noExternal: [
      ...bundledDependencies,
      /^react($|\/)/,
      /^react-dom($|\/)/,
      '@ricky0123/vad-web',
      // ORT-web has to come with `@ricky0123/vad-web`: esbuild rewrites that CJS
      // package's `require("onnxruntime-web")` to a `__require()` stub, and the
      // stub is hit while the module graph is still INITIALISING ("Dynamic require
      // of onnxruntime-web is not supported"), not lazily on first VAD use — which
      // aborts evaluation of the whole bundle just as a bare specifier would.
      /^onnxruntime-(web|common)($|\/)/,
      '@arcaai/stt',
      '@arcaai/noise-filter',
      'valibot',
      'deepmerge-ts',
      'diff',
    ],
    // esbuild empties `import.meta` on targets below es2020; `@arcaai/noise-filter`
    // resolves its WASM through `new URL(..., import.meta.url)`, so an older target
    // turns that into a "Invalid URL" throw instead of a harmless wrong URL.
    target: 'es2022',
  },
]);

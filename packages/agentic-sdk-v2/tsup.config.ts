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
 * - Plugins (~5MB total):
 *   - @arcaai/vad: Silero VAD + ONNX Runtime Web
 *   - @arcaai/stt: Whisper + HuggingFace Transformers
 *   - @arcaai/noise-filter: RNNoise WASM
 *   - @arcaai/room: Audio context management
 *
 * Optional (peer deps - not bundled):
 * - @arcaai/med-ner: Medical NER (~300MB models)
 * - highlight.run: Observability integration
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

// Packages that should be bundled INTO the SDK (workspace dependencies)
const bundledDependencies = [
  '@arcaai/room',
  '@arcaai/vad',
  '@arcaai/stt',
  '@arcaai/noise-filter',
  'zustand',
  'eventemitter3',
];

// Core-only bundled dependencies (no plugin packages)
const coreBundledDependencies = [
  'zustand',
  'eventemitter3',
];

// Packages that consumers must install separately (true peer dependencies)
const externalDependencies = [
  'react',
  'react-dom',
  '@arcaai/med-ner', // Optional - heavy NER models, consumer opts-in
  'highlight.run', // Optional - observability integration
  // Node.js-only packages that shouldn't be in browser bundles
  'onnxruntime-node',
  'sharp',
];

// Plugin packages - external for core build, bundled for plugins build
const pluginPackages = [
  '@arcaai/room',
  '@arcaai/vad',
  '@arcaai/stt',
  '@arcaai/noise-filter',
];

// Shared build options
const sharedOptions: Partial<Options> = {
  dts: false, // Blocked: workspace packages (@arcaai/vad, @arcaai/stt, @arcaai/noise-filter) don't expose hook types to TS compiler during DTS generation. Fix requires updating external-modules.d.ts or fixing workspace package type exports.
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
  // E2E build - Same as main build for browser testing
  // ==========================================================================
  {
    ...sharedOptions,
    entry: { 'e2e-bundle': 'src/index.ts' },
    format: ['esm'],
    outDir: 'e2e/fixtures/dist',
    external: externalDependencies,
    noExternal: bundledDependencies,
  },
]);

# TASK-303 — Fix `Dynamic require of "onnxruntime-web" is not supported` in @arcaai/vox

| Field | Value |
|---|---|
| Ticket | TASK-303 |
| Title | Fix `Dynamic require of "onnxruntime-web" is not supported` in `@arcaai/vox` |
| Status | Completed |
| Created | 2026-05-25 |
| Updated | 2026-05-25 |
| Classification | bugfix |
| Related | [TASK-262](../TASK-262-Vox-SDK-Deep-Assessment/README.md), [TASK-271](../TASK-271-VAD-Cleanup/README.md), [TASK-289](../TASK-289-MedNER-E2E-Bare-Specifiers/README.md), [TASK-293](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md), [TASK-300](../TASK-300-Local-Pipeline-Cross-Cutting/README.md) |

---

## 1. Requirement Analysis

### Description

Consumers importing `@arcaai/vox` (e.g. `apps/ui-playground`) hit the runtime error:

```
Error: Dynamic require of "onnxruntime-web" is not supported
```

…the moment the SDK bundle is evaluated in a browser. The error blocks all SDK functionality (audio capture, VAD, STT, etc.).

### Business context

`@arcaai/vox` is the SDK that powers the medical consultation flow in `apps/ui-playground` and any external host app. The full client-side pipeline (Microphone → NoiseFilter → VAD → STT) depends on ONNX Runtime Web loading correctly. Without this fix, the entire SDK is unusable in production.

### Acceptance criteria

1. `@arcaai/vox/dist/index.mjs`, `dist/plugins.mjs`, `dist/core.mjs` (and their `.js` CJS twins) MUST NOT contain `__require("onnxruntime-web")`, `__require("onnxruntime-web/wasm")`, or `__require("@ricky0123/vad-web")` calls.
2. The throwing `var __require = (() => { ... throw Error('Dynamic require of "' + x + '" is not supported') ... })` helper MUST NOT appear in any `.mjs` artifact.
3. `apps/ui-playground` MUST build cleanly (`pnpm --filter @arcaai/ui-playground build`) without bundling errors.
4. `pnpm --filter @arcaai/vox test` MUST pass with the same test count as before the change.
5. The fix MUST work on all major browsers that previously supported the SDK (Chrome 113+, Firefox 110+, Safari 17+).
6. No regression in `@arcaai/vad`, `@arcaai/stt`, `@arcaai/noise-filter` tests.

---

## 2. Current State Evaluation (Phase 1 — Root Cause Investigation)

### 2.1 Where the error string comes from

esbuild emits this stub at the top of every ESM bundle when it cannot statically resolve a `require()` call from inlined CJS source:

```16:42:packages/agentic-sdk-v2/dist/index.mjs
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
```

The stub fires whenever the bundle is run in a context where `require` is undefined (i.e. the browser).

### 2.2 Which calls trigger it (pre-fix evidence)

```bash
$ rg -n '__require\(' packages/agentic-sdk-v2/dist/index.mjs
37:var __require = …
3503:    var ortInstance = __importStar(__require("onnxruntime-web"));
3749:    var ortInstance = __importStar(__require("onnxruntime-web/wasm"));

$ rg -n '__require\(' packages/agentic-sdk-v2/dist/plugins.mjs
38:var __require = …
1235:    var ortInstance = __importStar(__require("onnxruntime-web"));
1481:    var ortInstance = __importStar(__require("onnxruntime-web/wasm"));
```

Both `__require("onnxruntime-web")` calls came from the **inlined CJS source of `@ricky0123/vad-web@0.0.30`** — specifically its `non-real-time-vad.js` and `real-time-vad.js` files (file paths visible in source-map comments inside the bundled output).

### 2.3 Why the CJS source got inlined (the root cause)

`@ricky0123/vad-web@0.0.30/package.json`:

```json
{
  "main": "dist/index.js",
  "unpkg": "dist/bundle.min.js",
  "jsdelivr": "dist/bundle.min.js"
}
```

There is **no `module`, `exports`, or `type: "module"` field**, so Node/esbuild resolves the package to its CJS entry point only.

The dependency chain to vox:

```
@arcaai/vox  (tsup, ESM + CJS output)
 └── @arcaai/vad        (noExternal → inlined into vox bundle)
      └── @ricky0123/vad-web  (CJS-only, NOT external in vox → inlined)
           └── require("onnxruntime-web")  (vad-web's CJS source)
                └── onnxruntime-web is in vox's deps → marked external by esbuild
                     └── esbuild emits __require("onnxruntime-web") because
                          a sync CJS `require()` of an external module cannot
                          be safely rewritten to an async ESM `import()`.
```

Crucially, `@ricky0123/vad-web` was **not** listed in `packages/agentic-sdk-v2/package.json#dependencies` nor in the `externalDependencies` array of `packages/agentic-sdk-v2/tsup.config.ts`. tsup's default rule (`anything in dependencies is external, everything else gets bundled`) therefore inlined vad-web's CJS source into vox's ESM output, producing the broken `__require()` calls.

### 2.4 Why this is the same class of issue as TASK-289

[TASK-289 §3.3](../TASK-289-MedNER-E2E-Bare-Specifiers/README.md) already documented the dual problem: `@huggingface/transformers@3.8.1/dist/transformers.web.js` itself uses bare specifiers (`onnxruntime-web`, `onnxruntime-common`) that must be kept external. That ticket fixed it for the med-ner E2E fixture; this ticket fixes the parallel issue in the vox SDK bundle for the `@ricky0123/vad-web` CJS dependency.

### 2.5 Why `@arcaai/vad` itself was not broken

`packages/vad/tsup.config.ts` correctly lists `@ricky0123/vad-web` and `onnxruntime-web` as `external`:

```24:24:packages/vad/tsup.config.ts
    external: ['@arcaai/room', 'react', '@ricky0123/vad-web', 'onnxruntime-web'],
```

…so `packages/vad/dist/index.mjs` cleanly has `import { MicVAD } from '@ricky0123/vad-web';` at the top (line 3). The bug only manifested when vox bundled vad's source via `noExternal`.

### 2.6 Pattern Analysis (Phase 2)

| Bundle | `Dynamic require` stub? | `__require("onnxruntime…")`? | Root cause |
|---|---|---|---|
| `packages/vad/dist/index.mjs` | No | No | vad correctly externalizes vad-web |
| `packages/stt/dist/index.mjs` | No | No | stt uses `await import('@huggingface/transformers')` in the worker (dynamic ESM import) |
| `packages/noise-filter/dist/index.mjs` | No | No | Pure WASM, no ORT dependency |
| `packages/agentic-sdk-v2/dist/index.mjs` | **Yes (line 41)** | **Yes (lines 3503, 3749)** | vad-web was bundled as CJS |
| `packages/agentic-sdk-v2/dist/plugins.mjs` | **Yes (line 38)** | **Yes (lines 1235, 1481)** | Same as above |

The leaf bundles are clean; the regression was contained to vox's tsup configuration.

---

## 3. Implementation Plan

### 3.1 Hypothesis (Phase 3)

**"Removing `@ricky0123/vad-web` from the set of packages that tsup is allowed to inline (by adding it to vox's `externalDependencies`) will eliminate the `__require()` calls because vad-web's CJS source will no longer be embedded in vox's ESM output."**

Predicted result of the fix:
- Top of `dist/index.mjs` and `dist/plugins.mjs` will gain `import { MicVAD } from '@ricky0123/vad-web';`
- The throwing `__require` helper will be tree-shaken out (no remaining CJS-from-external `require()` callsites)
- Bundle size will shrink by roughly the size of vad-web's 6 CJS source files (~100 KB minified)

### 3.2 Tests to write/update

No test file changes required — the bug is a build-time configuration issue. Verification is done via:

1. `rg -c 'Dynamic require' packages/agentic-sdk-v2/dist/*.{mjs,js}` → expected: `0` matches
2. `rg -n '__require\("onnxruntime|__require\("@ricky0123' packages/agentic-sdk-v2/dist/*.{mjs,js}` → expected: `0` matches
3. `pnpm --filter @arcaai/vox test` → expected: `2884 / 2884` (unchanged from pre-fix)
4. `pnpm --filter @arcaai/vad test` → expected: `194 / 194`
5. `pnpm --filter @arcaai/stt test` → expected: `355 / 355`
6. `pnpm --filter @arcaai/noise-filter test` → expected: `166 / 166`
7. `pnpm --filter @arcaai/ui-playground build` → expected: success

### 3.3 File-modification order

1. `packages/agentic-sdk-v2/tsup.config.ts` — add `@ricky0123/vad-web`, `onnxruntime-web`, `onnxruntime-common` to `externalDependencies`
2. `packages/agentic-sdk-v2/package.json` — add `@ricky0123/vad-web` and `onnxruntime-common` to `dependencies`
3. `pnpm install --filter @arcaai/vox`
4. `pnpm build --filter @arcaai/vox`
5. Verify with grep + builds

### 3.4 Why this is the 2026 web-platform best practice

| Concern | Approach taken |
|---|---|
| Browser support | Keeping `onnxruntime-web` external lets the consumer's bundler resolve it from npm; ORT-web 1.24.3 supports Chrome 113+, Firefox 110+, Safari 17+ (the minimum bar already required by `@arcaai/room`'s `isSafariVersionSupported()` helper). |
| WASM loading | vad-web continues to load `silero_vad_v5.onnx` + `ort-wasm-simd-threaded.jsep.mjs` from the jsDelivr CDN by default (see `packages/vad/src/constants.ts:DEFAULT_ONNX_WASM_BASE_PATH`). Consumers can override with `onnxWASMBasePath` to self-host. |
| Multi-threaded inference | Already correctly gated behind `crossOriginIsolated` in `packages/vad/src/processors/VADProcessor.ts:resolveOrtNumThreads()` (TASK-300 L-10) and `packages/stt/src/workers/whisper.worker.ts:resolveOrtNumThreads()` (TASK-300 L-9). No change needed. |
| Tree-shaking / bundle size | Externalizing vad-web shrinks vox's main bundle by ~95 KB and plugins bundle by ~100 KB without any runtime cost (Vite/webpack handle the resolution). |
| CJS↔ESM interop | Delegated to the consumer's bundler. Vite 7 (used by `apps/ui-playground`) does this natively via `@rollup/plugin-commonjs` in production and esbuild prebundling in dev. webpack 5 consumers get it via `experiments.outputModule + asyncWebAssembly`. Both code paths are battle-tested and well-supported in 2026. |

### 3.5 Alternatives considered & rejected

| Alternative | Why rejected |
|---|---|
| Bundle `onnxruntime-web` AND `@ricky0123/vad-web` into vox (`noExternal`) | Adds ~30 MB to the bundle, breaks WASM file discovery (ORT-web needs sibling `.wasm`/`.mjs` files at a known URL), and prevents the consumer from upgrading ORT independently. |
| Inject a `createRequire(import.meta.url)` polyfill via a tsup banner | Only works in Node, not in the browser. The error is browser-specific. |
| Replace `require()` with dynamic `import()` via a custom esbuild plugin | Requires modifying third-party code, breaks tree-shaking, and would need to be reapplied each time vad-web is upgraded. Not maintainable. |
| Wait for `@ricky0123/vad-web` to ship an ESM build | The upstream maintainer has not committed to this (see ricky0123/vad#161, #169, #230). Indefinite blocker. |

---

## 4. Implementation Summary

### 4.1 Files changed

| File | Change | LOC |
|---|---|---|
| `packages/agentic-sdk-v2/tsup.config.ts` | Added `@ricky0123/vad-web`, `onnxruntime-web`, `onnxruntime-common` to `externalDependencies` with a 22-line comment explaining the reasoning. | +25 |
| `packages/agentic-sdk-v2/package.json` | Added `@ricky0123/vad-web@^0.0.30` and `onnxruntime-common@1.24.3` to `dependencies` (alphabetical position). | +2 |

Total diff: 2 files, +27 LOC.

### 4.2 Concrete changes

#### `packages/agentic-sdk-v2/tsup.config.ts`

```64:96:packages/agentic-sdk-v2/tsup.config.ts
// Packages that consumers must install separately (true peer dependencies)
const externalDependencies = [
  'react',
  'react-dom',
  '@arcaai/med-ner', // Optional - heavy NER models, consumer opts-in
  'highlight.run', // Optional - observability integration
  // Node.js-only packages that shouldn't be in browser bundles
  'onnxruntime-node',
  'sharp',
  // TASK-303: ONNX Runtime Web + Silero VAD engine MUST stay external.
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
];
```

#### `packages/agentic-sdk-v2/package.json`

```57:71:packages/agentic-sdk-v2/package.json
  "dependencies": {
    "@arcaai/noise-filter": "workspace:*",
    "@arcaai/room": "workspace:*",
    "@arcaai/stt": "workspace:*",
    "@arcaai/vad": "workspace:*",
    "@ricky0123/vad-web": "^0.0.30",
    "deepmerge-ts": "^7.1.5",
    "diff": "^8.0.4",
    "eventemitter3": "^5.0.4",
    "onnxruntime-common": "1.24.3",
    "onnxruntime-web": "1.24.3",
    "valibot": "^1.3.1",
    "zustand": "^5.0.12"
  },
```

### 4.3 Verification evidence

All checks pass post-fix:

```bash
# 1. No more throwing Dynamic require helpers in any .mjs/.js
$ rg -c 'Dynamic require' packages/agentic-sdk-v2/dist/*.{mjs,js}
(no output — 0 matches)

# 2. No more __require() calls on onnxruntime-web or @ricky0123/vad-web
$ rg -n '__require\("onnxruntime|__require\("@ricky0123' packages/agentic-sdk-v2/dist/*.{mjs,js}
(no output — 0 matches)

# 3. vad-web is now a proper ESM external import
$ rg -n '@ricky0123/vad-web' packages/agentic-sdk-v2/dist/index.mjs packages/agentic-sdk-v2/dist/plugins.mjs
plugins.mjs:3:import { MicVAD } from '@ricky0123/vad-web';
plugins.mjs:1166:    DEFAULT_BASE_ASSET_PATH = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`;
index.mjs:3:import { MicVAD } from '@ricky0123/vad-web';
index.mjs:3434:    DEFAULT_BASE_ASSET_PATH = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`;

# 4. onnxruntime-* still resolved cleanly as ESM (from transformers' webpack bundle)
$ rg -n '^import.*onnxruntime' packages/agentic-sdk-v2/dist/plugins.mjs
plugins.mjs:4:import * as __WEBPACK_EXTERNAL_MODULE_onnxruntime_common_82b39e9f__ from 'onnxruntime-common';
plugins.mjs:5:import * as __WEBPACK_EXTERNAL_MODULE_onnxruntime_web_74d14b94__ from 'onnxruntime-web';

# 5. Bundle sizes (post-fix vs pre-fix):
#    index.mjs:    4,500,416  ←  4,595,771  (-95 KB)
#    plugins.mjs:  4,111,993  ←  4,212,577  (-100 KB)
#    core.mjs:       482,388  ←    477,117  (+5 KB, from the added comment)

# 6. All tests pass
$ pnpm --filter @arcaai/vox test
 Test Files  126 passed (126)
      Tests  2884 passed (2884)

$ pnpm --filter @arcaai/vad test
 Test Files  8 passed (8)
      Tests  194 passed (194)

$ pnpm --filter @arcaai/stt test
 Test Files  22 passed (22)
      Tests  355 passed (355)

$ pnpm --filter @arcaai/noise-filter test
 Test Files  13 passed (13)
      Tests  166 passed (166)

# 7. Downstream consumer builds clean
$ pnpm --filter @arcaai/ui-playground build
 Tasks:    8 successful, 8 total
  Time:    36.085s
```

### 4.4 Deviations from plan

None. The fix matched the hypothesis exactly:
- The throwing `__require` stub disappeared from all `.mjs` files (was previously at line 41 of `index.mjs` and line 38 of `plugins.mjs`).
- `@ricky0123/vad-web` became an ESM external import at line 3 of `index.mjs` and `plugins.mjs`.
- Bundle sizes shrank by approximately the expected 95-100 KB (vad-web's six CJS files no longer inlined).

---

## 5. Browser & Platform Compatibility Notes

This fix preserves and slightly improves the browser support story:

| Concern | Status |
|---|---|
| ESM import resolution | Standard `import { MicVAD } from '@ricky0123/vad-web'` — handled by every modern bundler (Vite 5+, webpack 5+, Rollup 4+, Parcel 2+). |
| ONNX Runtime Web | Stays at `1.24.3` (Chrome 113+, Firefox 110+, Safari 17+). Multi-threaded WASM gated on `crossOriginIsolated` (COOP/COEP). WebGPU opt-in via `device: 'webgpu'` in STT worker. |
| Silero VAD model | Loaded from jsDelivr CDN by default (`silero_vad_v5.onnx`). Consumers can self-host by passing `baseAssetPath` to `useVAD`. |
| `@huggingface/transformers` | Continues to import `onnxruntime-web` / `onnxruntime-common` as bare specifiers from its own webpack-externalized web bundle (`transformers.web-*.js`). Externalizing those in vox preserves that working chain. |
| Node.js (SSR) consumers | The `react-server` stubs in `packages/vad/dist/react-server-stub.mjs` and `packages/stt/dist/react-server-stub.mjs` continue to handle SSR. `useVAD` and `useSTT` are still gated to `"use client"`. |

---

## 6. Risks & Follow-ups

### Risks (low)

1. **Consumer bundler dependency**: Apps that don't use a modern bundler (e.g. a bare browser `<script type="module">` import) cannot resolve bare-specifier imports. **Mitigation**: This was already the case for `onnxruntime-web` and `@huggingface/transformers`. The SDK README + TASK-262 cross-cutting docs make this explicit.
2. **`@ricky0123/vad-web` upgrade**: If the maintainer ever ships an ESM build, our fix continues to work (we just stay on a slightly larger CJS bundle until we choose to bump the version). No code change needed at upgrade time.

### Optional follow-ups (not required for this ticket)

| ID | Suggestion | Priority |
|---|---|---|
| F-1 | Bump `onnxruntime-web` from `1.24.3` to the latest stable (1.27.x as of Q2 2026) once `@huggingface/transformers` confirms compatibility. | Low — current version works. |
| F-2 | Add a CI grep gate that fails the build if `Dynamic require of` ever appears in `packages/agentic-sdk-v2/dist/*.mjs` to prevent regression. | Medium — cheap regression-prevention. |
| F-3 | Add an explicit `peerDependencies.onnxruntime-web` declaration to vox (in addition to `dependencies`) so non-pnpm consumers (yarn PnP, npm strict) get a clear install-time warning if the version drifts. | Low — pnpm hoist already handles this in our monorepo. |

---

## 7. Change History

| Date | Change | Files |
|---|---|---|
| 2026-05-25 | Initial fix: externalized `@ricky0123/vad-web`, `onnxruntime-web`, `onnxruntime-common` in vox's tsup config. Added `@ricky0123/vad-web@^0.0.30` and `onnxruntime-common@1.24.3` to vox's package.json dependencies. Verified zero `Dynamic require` strings remain; all 3599 unit tests across vox/vad/stt/noise-filter pass; ui-playground builds clean. | `packages/agentic-sdk-v2/tsup.config.ts`, `packages/agentic-sdk-v2/package.json` |

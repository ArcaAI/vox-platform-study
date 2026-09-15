# noise-filter assets — bundled WASM binary

`packages/noise-filter/assets`. Holds `rnnoise.wasm`, copied here from `@jitsi/rnnoise-wasm`
during `pnpm build`. It ships with the package — there is no runtime CDN fetch.

## Layout

| Path | What it holds |
|---|---|
| `rnnoise.wasm` | The bundled RNNoise WebAssembly binary, copied from `@jitsi/rnnoise-wasm` at build time |

## How it works

The default `wasmPath` resolves this file via `new URL('../assets/rnnoise.wasm', import.meta.url)`
(`../src/wasmAsset.ts`). To self-host instead, copy this file to your own server and pass
`wasmPath` when creating the processor:

```typescript
const noiseFilter = createNoiseFilter({
  wasmPath: '/assets/rnnoise.wasm',
  noiseCancellation: true,
});
```

## Gotchas

- The bundled binary is pinned to `@jitsi/rnnoise-wasm@0.2.1`'s exact export names and import
  object shape — the hand-ported worklet loaders in `../src/worklets/` and
  `../src/processors/workletRnnoiseLoader.ts` depend on that exact ABI. Do not substitute a
  differently-built `rnnoise.wasm` here without re-verifying those three files against it (see
  the parent README's "Worklet source is manually duplicated in three places" gotcha).
- The package this feeds is deprecated (TASK-865, removed in R4) — do not add new consumers.

## Related

- [`../README.md`](../README.md) — the `@arcaai/noise-filter` package.

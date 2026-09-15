# VAD assets — model notes

`packages/vad/assets`. This directory holds no model files. The Silero VAD ONNX models are loaded
from the `@ricky0123/vad-web` package's CDN distribution, or from a self-hosted path you
configure — nothing is bundled here.

## Layout

| Path | What it holds |
|---|---|
| `README.md` | This file — nothing else lives in this directory |

## How it works

### Available models

| Model | Frame size | Notes |
|---|---|---|
| `silero_vad_v5.onnx` (recommended) | 512 samples | Supports 6000+ languages, better performance in noisy environments |
| `silero_vad_legacy.onnx` | 1536 samples | Broader browser compatibility |

### Asset configuration

By default, assets are loaded from the jsDelivr CDN (version-pinned via `VAD_WEB_VERSION` /
`ORT_WEB_VERSION` in `../src/constants.ts`). For self-hosting, configure the paths:

```typescript
const vad = new VADProcessor({
  baseAssetPath: '/assets/vad/',
  onnxWASMBasePath: '/assets/onnx/',
});
```

### Required files for self-hosting

- `silero_vad_v5.onnx` (or `silero_vad_legacy.onnx`)
- `vad.worklet.bundle.min.js`
- ONNX Runtime WASM files from `onnxruntime-web`

## Gotchas

- The package this feeds is deprecated (TASK-865, removed in R4) — do not add new consumers.

## Related

- [`../README.md`](../README.md) — the `@arcaai/vad` package.

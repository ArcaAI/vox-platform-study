# STT assets — model notes

`packages/stt/assets`. This directory holds no model files. `@arcaai/stt`'s deprecated local
provider uses `@huggingface/transformers`, which downloads and caches Whisper models from the
Hugging Face Hub at runtime — no manual model download is required, and nothing is bundled here.

## Layout

| Path | What it holds |
|---|---|
| `README.md` | This file — nothing else lives in this directory |

## How it works

### Supported models

| Model ID | Size | Description |
|---|---|---|
| `onnx-community/whisper-tiny.en` | ~40MB | English-only, fastest |
| `onnx-community/whisper-base.en` | ~75MB | English-only, balanced |
| `onnx-community/whisper-small.en` | ~240MB | English-only, high accuracy |
| `Xenova/whisper-tiny` | ~40MB | Multilingual, fastest |
| `Xenova/whisper-base` | ~75MB | Multilingual, balanced |
| `Xenova/whisper-small` | ~240MB | Multilingual, high accuracy |

### Model caching

Models are cached in the browser's IndexedDB storage via Transformers.js. The first load may take
a few seconds depending on network speed; subsequent loads are instant.

### Custom models

Local models are selected via `features.modelId`, which accepts either a Whisper size (`tiny`,
`base`, `small`, ...) or a full Hugging Face repo id:

```typescript
import { createSTT } from '@arcaai/stt';

const stt = createSTT({
  features: {
    provider: 'local',
    modelId: 'onnx-community/whisper-base',
  },
});
```

Namespaced repo ids are loaded verbatim; bare sizes resolve to
`onnx-community/whisper-<size>` (see `resolveLocalWhisperModel` in `../src/types/index.ts`).

## Gotchas

- The local provider this feeds is deprecated (TASK-865, removed in R4) — do not add new
  consumers of `provider: 'local'`.

## Related

- [`../README.md`](../README.md) — the `@arcaai/stt` package.

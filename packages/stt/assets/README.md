# STT Assets

This directory is reserved for any static assets required by the STT package.

## Model Files

The `@arcaai/stt` package uses `@huggingface/transformers` which automatically downloads and caches Whisper models from Hugging Face Hub. No manual model download is required.

### Supported Models

| Model ID                          | Size   | Description                 |
| --------------------------------- | ------ | --------------------------- |
| `onnx-community/whisper-tiny.en`  | ~40MB  | English-only, fastest       |
| `onnx-community/whisper-base.en`  | ~75MB  | English-only, balanced      |
| `onnx-community/whisper-small.en` | ~240MB | English-only, high accuracy |
| `Xenova/whisper-tiny`             | ~40MB  | Multilingual, fastest       |
| `Xenova/whisper-base`             | ~75MB  | Multilingual, balanced      |
| `Xenova/whisper-small`            | ~240MB | Multilingual, high accuracy |

### Model Caching

Models are cached in the browser's IndexedDB storage via the Transformers.js library. The first load may take a few seconds depending on network speed, but subsequent loads will be instant.

### Custom Models

Local models are selected via `features.modelId`, which accepts either a Whisper size (`tiny`, `base`, `small`, ...) or a full Hugging Face repo id:

```typescript
import { createSTT } from '@arcaai/stt';

const stt = createSTT({
  features: {
    provider: 'local',
    modelId: 'onnx-community/whisper-base',
  },
});
```

Namespaced repo ids are loaded verbatim; bare sizes resolve to `onnx-community/whisper-<size>` (see `resolveLocalWhisperModel` in `../src/types/index.ts`).

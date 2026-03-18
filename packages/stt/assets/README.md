# STT Assets

This directory is reserved for any static assets required by the STT package.

## Model Files

The `@arcaai/stt` package uses `@huggingface/transformers` which automatically downloads and caches Whisper models from Hugging Face Hub. No manual model download is required.

### Supported Models

| Model ID | Size | Description |
|----------|------|-------------|
| `onnx-community/whisper-tiny.en` | ~40MB | English-only, fastest |
| `onnx-community/whisper-base.en` | ~75MB | English-only, balanced |
| `onnx-community/whisper-small.en` | ~240MB | English-only, high accuracy |
| `Xenova/whisper-tiny` | ~40MB | Multilingual, fastest |
| `Xenova/whisper-base` | ~75MB | Multilingual, balanced |
| `Xenova/whisper-small` | ~240MB | Multilingual, high accuracy |

### Model Caching

Models are cached in the browser's IndexedDB storage via the Transformers.js library. The first load may take a few seconds depending on network speed, but subsequent loads will be instant.

### Custom Model Path

If you need to host models on your own server, you can configure a custom model path:

```typescript
import { createSTT } from '@arcaai/stt';

const stt = createSTT({
  modelPath: 'https://your-cdn.com/models/whisper-tiny.en',
});
```

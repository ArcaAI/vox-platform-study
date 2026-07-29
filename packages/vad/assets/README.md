# VAD Assets

This directory contains or will contain the Silero VAD model files.

## Model Files

The VAD package uses the Silero VAD models which are automatically loaded from the `@ricky0123/vad-web` package or from a configured CDN path.

### Available Models

1. **silero_vad_v5.onnx** - Silero VAD version 5 (recommended)
   - Frame size: 512 samples
   - Supports 6000+ languages
   - Better performance in noisy environments

2. **silero_vad_legacy.onnx** - Legacy Silero VAD model
   - Frame size: 1536 samples
   - Broader browser compatibility

## Asset Configuration

By default, assets are loaded from the jsDelivr CDN. For self-hosting, configure the paths:

```typescript
const vad = new VADProcessor({
  baseAssetPath: '/assets/vad/',
  onnxWASMBasePath: '/assets/onnx/',
});
```

## Required Files for Self-Hosting

When self-hosting, ensure the following files are available:

- `silero_vad_v5.onnx` (or `silero_vad_legacy.onnx`)
- `vad.worklet.bundle.min.js`
- ONNX Runtime WASM files from `onnxruntime-web`

## Download Models

To download the Silero VAD models:

```bash
# From npm package
npx @ricky0123/vad-web
```

Or download directly from:

- https://cdn.jsdelivr.net/npm/@ricky0123/vad-web/dist/silero_vad_v5.onnx
- https://cdn.jsdelivr.net/npm/@ricky0123/vad-web/dist/silero_vad_legacy.onnx

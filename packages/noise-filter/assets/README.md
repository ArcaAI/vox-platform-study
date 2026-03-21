# Assets

This directory is reserved for static assets used by the noise filter package.

## WASM Files

The RNNoise WASM file is loaded from the `@jitsi/rnnoise-wasm` npm package by default. If you need to self-host the WASM file:

1. Download the WASM file from the npm package or build from source
2. Place it in your application's public/assets directory
3. Configure the `wasmPath` option when creating the processor:

```typescript
const noiseFilter = new NoiseFilterProcessor({
  wasmPath: '/assets/rnnoise.wasm',
  noiseCancellation: true,
});
```

## Building RNNoise WASM from Source

If you need to build the WASM file from source:

1. Clone the RNNoise repository: https://github.com/xiph/rnnoise
2. Install Emscripten SDK
3. Build with:

```bash
emcc -O3 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_rnnoise_create","_rnnoise_destroy","_rnnoise_process_frame","_malloc","_free"]' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="RNNoise" \
  src/*.c -o rnnoise.js
```

The resulting `rnnoise.wasm` file can be used with this package.

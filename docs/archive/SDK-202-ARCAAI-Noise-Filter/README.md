# SDK-202: @arcaai/noise-filter Package

## Header

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| Ticket       | SDK-202                                        |
| Feature Name | AI-Powered Noise Cancellation Plugin           |
| Created      | 2026-01-10                                     |
| Last Updated | 2026-01-10                                     |
| Status       | Completed                                      |

## Requirement Analysis

### Description

Create a noise filter plugin package (`@arcaai/noise-filter`) that provides AI-powered noise cancellation for `@arcaai/room`. The plugin uses RNNoise (Mozilla's open-source deep learning noise suppression) via WebAssembly for high-quality, real-time noise cancellation in the browser.

### Business Context

The package enables:
- Superior noise cancellation compared to WebRTC native
- Consistent noise reduction across all browsers
- Real-time processing with minimal latency
- Configurable intensity levels for different environments
- Statistics monitoring for debugging and optimization

### Reference Material

- RNNoise: https://jmvalin.ca/demo/rnnoise/
- Mozilla RNNoise Blog: https://hacks.mozilla.org/2017/09/rnnoise-deep-learning-noise-suppression/
- AudioWorklet API: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- @arcaai/room package: `packages/room/`

## Current State Evaluation

This is a new package - builds on the `@arcaai/room` plugin architecture established in SDK-201.

## Implementation Plan

### Technology Decisions

| Feature | Technology | Rationale |
|---------|------------|-----------|
| Noise Cancellation | RNNoise WASM | Open-source, high-quality, low CPU |
| Audio Processing | AudioWorklet | Low-latency, off-main-thread |
| Echo Cancellation | WebRTC Native | Browser-optimized, hardware-accelerated |
| Fallback | ScriptProcessor | Broad browser support |

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    @arcaai/noise-filter                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ NoiseFilterProcessor (extends BaseProcessor)               │ │
│  │                                                            │ │
│  │  ┌──────────────┐    ┌──────────────┐    ┌─────────────┐  │ │
│  │  │ Source Node  │───▶│ AudioWorklet │───▶│ Destination │  │ │
│  │  └──────────────┘    │ or Script    │    │    Node     │  │ │
│  │                      │ Processor    │    └─────────────┘  │ │
│  │                      └──────────────┘                     │ │
│  │                             │                              │ │
│  │                      ┌──────┴───────┐                     │ │
│  │                      │ RNNoiseProc  │                     │ │
│  │                      │ (WASM)       │                     │ │
│  │                      └──────────────┘                     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `packages/noise-filter/package.json` | Package configuration |
| `packages/noise-filter/tsconfig.json` | TypeScript configuration |
| `packages/noise-filter/tsconfig.build.json` | Build configuration |
| `packages/noise-filter/tsup.config.ts` | Build tool configuration |
| `packages/noise-filter/src/index.ts` | Public API exports |
| `packages/noise-filter/src/types/index.ts` | Type definitions |
| `packages/noise-filter/src/processors/NoiseFilterProcessor.ts` | Main processor class |
| `packages/noise-filter/src/processors/RNNoiseProcessor.ts` | RNNoise WASM wrapper |
| `packages/noise-filter/src/processors/index.ts` | Processor exports |
| `packages/noise-filter/src/worklets/rnnoise.worklet.ts` | AudioWorklet processor |
| `packages/noise-filter/src/worklets/worklet-loader.ts` | Worklet registration utility |
| `packages/noise-filter/src/worklets/index.ts` | Worklet exports |
| `packages/noise-filter/src/utils/browserSupport.ts` | Feature detection |
| `packages/noise-filter/src/utils/index.ts` | Utils exports |
| `packages/noise-filter/README.md` | Package documentation |

### Key Features Implemented

1. **NoiseFilterProcessor**
   - Extends `BaseProcessor` from `@arcaai/room`
   - Implements `TrackProcessor` interface
   - Supports enable/disable without restart
   - Emits processing statistics

2. **RNNoiseProcessor**
   - Low-level RNNoise WASM wrapper
   - Frame buffering (128 → 480 samples)
   - Configurable noise levels
   - Statistics tracking

3. **AudioWorklet Integration**
   - Off-main-thread processing
   - Dynamic worklet registration
   - Inline worklet source for bundling
   - Message-based communication

4. **Browser Support**
   - Comprehensive feature detection
   - Safari version checking
   - Fallback to ScriptProcessor
   - Native NS fallback

5. **Statistics Monitoring**
   - VAD probability
   - Noise reduction estimate
   - CPU load tracking
   - Frame processing counts

### Dependencies

```json
{
  "dependencies": {
    "@rnnoise/rnnoise-wasm": "^1.0.0"
  },
  "peerDependencies": {
    "@arcaai/room": "^0.1.0"
  }
}
```

### Integration with @arcaai/room

The plugin follows the `TrackProcessor` interface:

```typescript
import { NoiseFilterProcessor } from '@arcaai/noise-filter';
import { useAudioTrack } from '@arcaai/room';

const { track } = useAudioTrack({
  noiseSuppression: false,  // Disable native NS
});

const noiseFilter = new NoiseFilterProcessor({
  noiseCancellation: true,
  noiseCancellationLevel: 'high',
});

await track.setProcessor(noiseFilter);
```

### Browser Compatibility

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome 66+ | Full | AudioWorklet + WASM |
| Firefox 76+ | Full | AudioWorklet + WASM |
| Safari 17.4+ | Full | AudioWorklet + WASM |
| Safari < 17.4 | Partial | ScriptProcessor fallback |
| Edge 79+ | Full | Chromium-based |

### Testing Performed

- TypeScript compilation verification
- Package structure validation
- Linting configuration

### Future Considerations

1. Add unit tests with Vitest
2. Add integration tests with @arcaai/room
3. Add performance benchmarks
4. Consider supporting multiple noise models
5. Add voice enhancement features
6. Explore WebGPU acceleration for newer browsers

## Change History

*No changes since initial implementation*

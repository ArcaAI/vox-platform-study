# @arcaai/utils

Shared utility functions for the HOPE platform: date/number/string formatting, validation helpers, and a browser-oriented ML model management stack (downloading, registry lookup, Cache Storage integration for Transformers.js and ONNX models). Built with tsup to dual CJS/ESM output.

Last updated: 2026-07-04

## Position in the stack

`@arcaai/utils` is a leaf utility package that depends only on `@arcaai/types`. It currently has no workspace consumers importing it directly; it is kept as the designated home for framework-agnostic helpers shared by frontend packages. The model-management modules target browsers (they use `fetch`, Cache Storage, and IndexedDB-adjacent APIs) — do not use them from Node services.

## Directory structure

```
src/
├── index.ts                   # Barrel export
├── date.ts                    # formatDuration, formatDate/Time/DateTime, getRelativeTime, isToday, now
├── format.ts                  # formatFileSize, formatNumber, truncate, formatPercentage, formatTimecode(Hours)
├── string.ts                  # capitalize, toTitleCase/KebabCase/CamelCase/PascalCase, randomString, generateUUID, escapeHtml
├── validation.ts              # isValidEmail, isValidUrl, isEmpty, isDefined, isValidUUID, isInRange, isValidLength
├── ModelDownloader.ts         # ModelConfig, DownloadProgress, ModelDownloader class
├── ModelLoader.ts             # ModelLoader class + getModelLoader() singleton
├── ModelManagementService.ts  # ModelManagementService (extends ModelDownloader) + singleton
├── ModelSourceManager.ts      # Model source/registry config (HuggingFace repos) + singleton
├── model-registry.ts          # VAD_MODELS, TRANSCRIPTION_MODELS, DIARIZATION_MODELS, lookup helpers
├── model-urls.ts              # SILERO_VAD_MODEL, speaker-embedding model configs, MODEL_REGISTRY
├── transformers-cache.ts      # Transformers.js Cache Storage helpers (shared + tenant-scoped caches)
└── __tests__/                 # Vitest suites for date, format, string, validation, transformers-cache
```

## Key APIs

### Formatting and validation

Behavior matches the unit tests in `src/__tests__/`:

```typescript
import { formatDuration, formatFileSize, isValidEmail, isValidUUID } from '@arcaai/utils';

formatDuration(90);        // '1m 30s'
formatDuration(3661);      // '1h 1m 1s'
formatFileSize(1048576);   // '1.00 MB'
isValidEmail('a@b.co');    // true
isValidUUID('not-a-uuid'); // false
```

Date helpers accept the `Timestamp` type (ISO string) from `@arcaai/types`:

```typescript
import { formatDateTime, getRelativeTime, now } from '@arcaai/utils';

const ts = now();                 // ISO timestamp string
formatDateTime(ts, 'en-US');      // locale-formatted date + time
getRelativeTime(ts);              // Intl.RelativeTimeFormat output, e.g. '2 hours ago'
```

### Model management (browser)

Singletons orchestrate download, caching, and loading of ML models:

| Export | Purpose |
|---|---|
| `ModelDownloader` / `ModelConfig` / `DownloadProgress` | Fetch model files with progress callbacks |
| `ModelManagementService` / `getModelManagementService()` | Orchestrates availability, updates, and storage of registered models |
| `ModelLoader` / `getModelLoader()` | Loads models into runtimes (ONNX Runtime, Transformers.js) |
| `ModelSourceManager` / `getModelSourceManager()` | Resolves model sources (HuggingFace repos vs. local mirrors) |
| `model-registry` | Static registries: `VAD_MODELS`, `TRANSCRIPTION_MODELS`, `DIARIZATION_MODELS`, `SPEAKER_RECOGNITION_MODELS`, plus `getModelById`, `getModelsByCategory`, `getEssentialModelsFromRegistry` |
| `model-urls` | Named `ModelConfig` constants (`SILERO_VAD_MODEL`, `SPEAKER_EMBEDDING_MODEL`, ...) and `MODEL_REGISTRY` |

```typescript
import { getModelManagementService, getModelById } from '@arcaai/utils';

const svc = getModelManagementService();
const model = getModelById('silero-vad');
```

### Transformers.js cache helpers

`transformers-cache.ts` manages the browser Cache Storage entries Transformers.js writes model weights into. Public (HuggingFace hub) weights share one origin-wide cache (`transformers-cache`); tenant-published custom weights are isolated per tenant under `vox/<tenantId>/transformers` so one tenant can never read another tenant's private weights.

```typescript
import {
  getTransformersCacheName,
  isTransformersModelCached,
  clearTenantCustomTransformersCache,
} from '@arcaai/utils';

getTransformersCacheName();                                   // 'transformers-cache'
getTransformersCacheName({ source: 'custom', tenantId: 't1' }); // 'vox/t1/transformers'
await isTransformersModelCached('Xenova/whisper-tiny');
await clearTenantCustomTransformersCache('t1');
```

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsup` (CJS + ESM + d.ts, see `tsup.config.ts`) | `pnpm --filter @arcaai/utils build` |
| Watch | `tsup --watch` | `pnpm --filter @arcaai/utils dev` |
| Test | `vitest run` | `pnpm --filter @arcaai/utils test` |
| Test (watch) | `vitest --watch` | `pnpm --filter @arcaai/utils test:watch` |
| Coverage | `vitest run --coverage` | `pnpm --filter @arcaai/utils test:coverage` |
| Clean | `rm -rf dist *.tsbuildinfo` | `pnpm --filter @arcaai/utils clean` |

## Dependencies

- `@arcaai/types` — shared type definitions (`Timestamp`, `ModelMetadata`, `ModelCategory`, `ModelPriority`); marked external in the tsup build.

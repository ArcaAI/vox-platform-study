# @arcaai/utils — shared framework-agnostic helpers

Shared utility functions for the HOPE platform: date/number/string formatting, validation helpers,
the release-tag version grammar, and a browser-oriented ML model management stack (downloading,
registry lookup, Cache Storage integration for Transformers.js and ONNX models). Built with tsup to
dual CJS/ESM output. Depends only on `@arcaai/types`.

## Layout

| Path | What it holds |
|---|---|
| `src/index.ts` | Barrel export |
| `src/date.ts` | `formatDuration`, `formatDate/Time/DateTime`, `getRelativeTime`, `isToday`, `now` |
| `src/format.ts` | `formatFileSize`, `formatNumber`, `truncate`, `formatPercentage`, `formatTimecode(Hours)` |
| `src/string.ts` | `capitalize`, `toTitleCase`/`KebabCase`/`CamelCase`/`PascalCase`, `randomString`, `generateUUID`, `escapeHtml` |
| `src/validation.ts` | `isValidEmail`, `isValidUrl`, `isEmpty`, `isDefined`, `isValidUUID`, `isInRange`, `isValidLength` |
| `src/version-grammar.ts` | The release-tag grammar (`<SVC>-<M>.<m>.<p>[-pre]` / `ALL-<M>.<m>.<p>`) — parsing, platform-train detection, untagged-build version formatting |
| `src/ModelDownloader.ts` | `ModelConfig`, `DownloadProgress`, `ModelDownloader` class |
| `src/ModelLoader.ts` | `ModelLoader` class + `getModelLoader()` singleton |
| `src/ModelManagementService.ts` | `ModelManagementService` (extends `ModelDownloader`) + singleton |
| `src/ModelSourceManager.ts` | Model source/registry config (HuggingFace repos) + singleton |
| `src/model-registry.ts` | `VAD_MODELS`, `TRANSCRIPTION_MODELS`, `DIARIZATION_MODELS`, lookup helpers |
| `src/model-urls.ts` | `SILERO_VAD_MODEL`, speaker-embedding model configs, `MODEL_REGISTRY` |
| `src/transformers-cache.ts` | Transformers.js Cache Storage helpers (shared + tenant-scoped caches) |
| `src/__tests__/` | Vitest suites for date, format, string, validation, transformers-cache, version-grammar |

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsup` (CJS + ESM + d.ts, see `tsup.config.ts`) | `pnpm --filter @arcaai/utils build` |
| Watch | `tsup --watch` | `pnpm --filter @arcaai/utils dev` |
| Test | `vitest run` | `pnpm --filter @arcaai/utils test` |
| Test (watch) | `vitest --watch` | `pnpm --filter @arcaai/utils test:watch` |
| Coverage | `vitest run --coverage` | `pnpm --filter @arcaai/utils test:cov` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/utils typecheck` |
| Clean | `rm -rf dist *.tsbuildinfo` | `pnpm --filter @arcaai/utils clean` |

## How it works

### Formatting and validation

Behavior matches the unit tests in `src/__tests__/`:

```typescript
import { formatDuration, formatFileSize, isValidEmail, isValidUUID } from '@arcaai/utils';

formatDuration(90); // '1m 30s'
formatDuration(3661); // '1h 1m 1s'
formatFileSize(1048576); // '1.00 MB'
isValidEmail('a@b.co'); // true
isValidUUID('not-a-uuid'); // false
```

Date helpers accept the `Timestamp` type (ISO string) from `@arcaai/types`:

```typescript
import { formatDateTime, getRelativeTime, now } from '@arcaai/utils';

const ts = now(); // ISO timestamp string
formatDateTime(ts, 'en-US'); // locale-formatted date + time
getRelativeTime(ts); // Intl.RelativeTimeFormat output, e.g. '2 hours ago'
```

### Release-tag version grammar

`version-grammar.ts` is the CODE source of truth for the release tag grammar described in
`.claude/rules/09-infrastructure-devops.md` (`<SVC>-<M>.<m>.<p>[-pre]` or `ALL-<M>.<m>.<p>`,
`<SVC>` in `ALL API ADMIN GUARD HARNESS NLP TEXT STT TTS`). It is a real, consumed dependency:
`packages/applications/src/common/build-info/build-info.service.ts` imports
`formatUntaggedVersion(branch, commitSha)` to compute the `0.0.0-<branch-slug>.<sha8>` version
stamped into `build-info.json` for an untagged build.

```typescript
import { parseReleaseTag, isPlatformTrainTag, formatUntaggedVersion } from '@arcaai/utils';

parseReleaseTag('TEXT-2.1.0'); // { service: 'TEXT', major: 2, minor: 1, patch: 0, prerelease: undefined }
isPlatformTrainTag('ALL-1.4.0'); // true
formatUntaggedVersion('feature/foo', 'abc1234567'); // '0.0.0-feature-foo.abc12345'
```

### Model management (browser)

Singletons orchestrate download, caching, and loading of ML models. The model-management modules
target browsers (they use `fetch`, Cache Storage, and IndexedDB-adjacent APIs) — do not use them
from Node services.

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

Per `.claude/rules/08-vox-sdk.md`, the browser never runs a model by default — this stack backs the
deprecated client-inference path and any first-party admin surface is lint-banned from reaching it
directly.

### Transformers.js cache helpers

`transformers-cache.ts` manages the browser Cache Storage entries Transformers.js writes model
weights into. Public (HuggingFace hub) weights share one origin-wide cache (`transformers-cache`);
tenant-published custom weights are isolated per tenant under `vox/<tenantId>/transformers` so one
tenant can never read another tenant's private weights.

```typescript
import { getTransformersCacheName, isTransformersModelCached, clearTenantCustomTransformersCache } from '@arcaai/utils';

getTransformersCacheName(); // 'transformers-cache'
getTransformersCacheName({ source: 'custom', tenantId: 't1' }); // 'vox/t1/transformers'
await isTransformersModelCached('Xenova/whisper-tiny');
await clearTenantCustomTransformersCache('t1');
```

## Related

- [`09-infrastructure-devops.md`](../../.claude/rules/09-infrastructure-devops.md) — Release Versioning & Build-Metadata, the grammar `version-grammar.ts` implements
- [`08-vox-sdk.md`](../../.claude/rules/08-vox-sdk.md) — the client-side-inference gate this model-management stack backs

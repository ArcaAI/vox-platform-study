# `@arcaai/vox` SDK — Multi-Tenancy Code Review

> **Status update (2026-05-27)**: see [06-implementation-summary.md](./06-implementation-summary.md) for what was closed by TASK-305.

> **TASK-317 closure (2026-05-30):** Closed finding codes — C-1, C-2,
> C-3, C-4, C-5, D-1, D-2, D-3, D-4, D-5, D-6, E-1, E-2, E-3, E-4, E-5
> (all 16). Production-wiring deferred to follow-up: **D-3** (tenant-scoped
> transformers cache mechanism shipped + unit-tested but dormant — no
> in-repo caller) and **E-4** (`requireTenantClaim` opt-in, not wired
> into the prod streaming callers) — see
> [`09-vox-sdk-followup-closure.md`](./09-vox-sdk-followup-closure.md) §2.1.
> Wave merges: W1 `6947fd96`, W2 `15c3072a`, W3 `d9e961a5`,
> W4 `83f1db7b`, W5 `f19ef6fb` (W5 fixes ship as code commits D-3
> `db46a669`, D-6 `f2fbdcaf`, E-1 `478c61b2`, E-3 `6814c6fd`).
> Canonical closure record:
> [`09-vox-sdk-followup-closure.md`](./09-vox-sdk-followup-closure.md).
> In-line closure markers `[CLOSED W<n> <sha>]` appear on each finding
> heading in §C / §D / §E below (`[DEFERRED → 09 §2.1]` on D-3 + E-4) —
> finding bodies are preserved for historical lineage.

**Reviewer**: code-reviewer subagent
**Date**: 2026-05-25
**Scope**: `packages/agentic-sdk-v2`, `packages/room`, `packages/stt`, `packages/vad`, `packages/noise-filter`, `packages/pipeline`, `packages/ui`, `apps/ui-playground`, `apps/example`
**Files Reviewed**: ~45
**Overall Assessment**: **Request Changes** — safe in the *common* single-instance, single-tenant-per-tab usage; **NOT SAFE** for true multi-tenant browser scenarios (concurrent `AgenticProvider`s, fast tenant switching without page reload).

---

## A. SDK architecture summary

### Top-level architecture

`@arcaai/vox` (alias of `packages/agentic-sdk-v2`) is a React SDK for medical
consultation workflows. Tenant context flows in **one direction** from the
React tree down through a singleton Zustand store:

```
AgenticProvider (React)                                ← receives AgenticConfig {api.tenantId, accessToken, apiKey}
  ├─ AgenticClient                                    ← HTTP client; injects X-Tenant-ID + Authorization
  ├─ PluginManager  ──▶ TranscriptionPipeline         ← orchestrates noise-filter / VAD / STT
  │                  ──▶ KnowledgePipeline             ← NER, spell-check, summarisation
  │                  ──▶ StreamingSessionManager       ← mints sessionId + one-shot ticket
  │                  ──▶ SttV2WebSocketClient          ← /ws/stream?sessionId=...&ticket=...
  ├─ ModelRegistry           ← /tenant/me/config       ← per-tenant model defaults
  ├─ PersonalizationManager  ← IndexedDB + backend     ← user preferences
  ├─ ConfigManager           ← 4-tier cascade           ← SYSTEM → tenant → department → user
  ├─ SimpleCrossTabSync (per consultation)             ← BroadcastChannel + HMAC
  ├─ SharedConnectionManager → SharedConnectionWorker  ← multiplexes SSE/WS across tabs
  └─ SDKLogger (PHI-redaction, multi-transport)
```

### Where tenant context lives

| Layer                       | Tenant carrier                                                 |
| --------------------------- | -------------------------------------------------------------- |
| HTTP requests               | `X-Tenant-ID` header set by `AgenticClient`                    |
| Streaming HTTP/SSE/WS       | One-shot tickets minted by backend (tenant resolved server-side) |
| IndexedDB `user-preferences` store | `${tenantId}::${userId}` IDB key (good)               |
| IndexedDB `personalization` store  | **Global key `arcaai-personalization`** (BAD)         |
| `localStorage` (`arcaai-preferences`, `arcaai-selected-models`) | **Global keys** (BAD) |
| Zustand store               | **Module-level singleton** (BAD for multi-instance)            |
| BroadcastChannel name       | `agentic.<tenantId>` when known, else hash of consultation key |
| HMAC key (cross-tab)        | Per-SharedWorker session, regenerated on first use             |
| Audio pipeline & WASM       | None — pure browser singletons (AudioContext, WASM heap)       |

### Package dependency graph (high level)

```
@arcaai/vox  (consumer-facing SDK)
  ├─ @arcaai/room        (AudioContext singleton, MediaStream track mgmt)
  ├─ @arcaai/stt         (Whisper worker + remote WS client)
  ├─ @arcaai/vad         (Silero VAD)
  ├─ @arcaai/noise-filter (RNNoise WASM)
  ├─ @arcaai/pipeline    (TranscriptionPipeline / KnowledgePipeline orchestration)
  ├─ @arcaai/med-ner     (lazy-loaded)
  ├─ @arcaai/utils       (transformers-cache)
  └─ zustand, eventemitter3, valibot

apps/ui-playground   → consumes @arcaai/vox via <AgenticProvider>
apps/example         → does NOT consume @arcaai/vox; rolls its own fetch+WS demo
```

### Source-code key entry points

- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` — root provider & wiring
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts` — HTTP client w/ tenant header
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` — Zustand singleton store
- `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts` — user pref store
- `packages/agentic-sdk-v2/src/core/ModelRegistry.ts` — model selection & defaults
- `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts` — cross-tab connection multiplexer
- `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts` — BroadcastChannel layer
- `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` — STT streaming client
- `packages/room/src/core/AudioContextManager.ts` — `AudioContext` singleton
- `packages/agentic-sdk-v2/src/core/logger/SDKLogger.ts` + transports/ — observability

---

## B. Public API surface inventory

| Export                                | Tenant-aware? | Issues / notes                                                                                          |
| ------------------------------------- | :-----------: | ------------------------------------------------------------------------------------------------------- |
| `AgenticProvider`                     |       Y       | Accepts `config.api.tenantId`; namespaces IDB user-preferences as `${tenantId}::${userId}`              |
| `AgenticClient` (class)               |       Y       | `X-Tenant-ID` header on every request; `WeakMap`-stored impersonation token                             |
| `AgenticConfig.api.tenantId`          |       Y       | Optional. Hot-swappable via re-render; no explicit pre-swap state purge                                 |
| `useArca` / `useAuth` / `useTenants`  |       Y       | Inherit from `AgenticClient` + store                                                                    |
| `useAgenticStore` (re-exported state) |   N (shared)  | **Module-level singleton** — leaks across concurrent `AgenticProvider`s                                 |
| `useArcaConfig`                       |   partial     | Preferences scoped per (tenant,user) via `USER_PREFERENCES_STORE`; OK                                   |
| `PersonalizationManager`              |       N       | **Uses global key `arcaai-personalization` in `PERSONALIZATION_STORE`** — preferences leak across users |
| `ModelRegistry`                       |   partial     | Loads tenant defaults from `/tenant/me/config`; persists *selected* models to global `localStorage` key  |
| `StreamingSessionManager`             |       Y       | Mints server-side ticket; tenant resolved server-side                                                   |
| `SttV2WebSocketClient`                |       Y       | URL = `${wsUrl}?sessionId=...&ticket=...`; no JWT in URL                                                |
| `SSEClient`                           |       Y       | Same one-shot-ticket pattern; explicit comment forbidding JWT in URL                                    |
| `SharedConnectionWorker` (SSE side)   |       Y       | Dedup key = `${id}::${userId ?? 'anon'}`                                                                |
| `SharedConnectionWorker` (WS side)    |    **N**      | **Dedup key = `id` only** → cross-tenant WS multiplex risk                                              |
| `SimpleCrossTabSync`                  |       Y       | Channel namespaced; HMAC-signed                                                                         |
| `CrossTabHmacKeyManager`              |       Y       | Per-SharedWorker secret; not exfiltrated                                                                |
| `SDKLogger` + transports              |       Y       | `entry.user.tenantId` propagated; PHI fields redacted                                                   |
| `@arcaai/room` `AudioContextManager`  |   N (browser) | Singleton — correct given browser only has one audio path, but means all SDKs in tab share it           |
| `@arcaai/stt` worker(s)               |       N       | One Whisper worker per `STTProcessor` instance; isolated by Worker boundary                             |
| `@arcaai/utils` `transformers-cache`  |       N       | `Cache Storage` cache names not tenant-prefixed                                                         |
| `apps/example/LiveTranscriptionDemo`  |       Y       | Does not consume vox; sets `X-Tenant-ID` explicitly. Standalone — out of audit scope                    |

---

## C. Critical Findings (BLOCKER / HIGH)

### C-1 — Module-level Zustand store is a singleton (cross-instance state bleed) [CLOSED W4 `83f1db7b`]

**File**: `packages/agentic-sdk-v2/src/store/agenticStore.ts:306`
**Severity**: Critical

**Evidence**:
```306:312:packages/agentic-sdk-v2/src/store/agenticStore.ts
export const useAgenticStore = create<AgenticState & AgenticActions>((set, get) => ({
  ...initialState,
  // ...consultation, contextItems, transcript, authUser, apiClient, pluginManager,
  //    personalizationManager, modelRegistry, configManager, logger, ...
}));
```

The store is created once at module load and shared by every `AgenticProvider`
mounted in the same page. The store carries: `consultation`, `contextItems`,
`transcript`, `summary`, `authUser`, `apiClient`, `pluginManager`,
`personalizationManager`, `modelRegistry`, `configManager`.

**Attack / leakage scenario**

1. A multi-tenant operator-console UI mounts two `<AgenticProvider tenantId="A">`
   and `<AgenticProvider tenantId="B">` side by side (e.g. admin watching two
   tenants, or a SaaS reseller dashboard).
2. Both providers share the same `useAgenticStore`. Whichever mounts last
   overwrites `apiClient`, `pluginManager`, `personalizationManager`, etc.
3. Tenant-A's consultation/transcript/context become visible to tenant-B
   subscribers, and tenant-B's STT writes overwrite tenant-A's.
4. Even after unmounting one provider, the singleton retains the surviving
   tenant's `apiClient` — but the unmount path runs the **shared** `clearOnLogout`
   side-effects (`localStorage.removeItem('arcaai-preferences')`,
   `arcaai-user-preferences/*` keys, full IDB clear) on **the other tenant's
   data** too.

**Fix**:
- Make the store factory: `export const createAgenticStore = () => create(...)`.
- Hold the instance in `AgenticProvider` via `useRef` and expose through
  React context.
- Refactor the `useAgenticStore` import sites (~all hooks) to read via a
  `useStoreApi()` from context — Zustand's documented pattern.

**Effort**: Full (touches every hook). Could be staged: ship store-via-context
behind a flag; rename module export to `useGlobalAgenticStore` with deprecation
warning while migrating consumers.

---

### C-2 — `clearOnLogout` clears the *other* tenant's storage too [CLOSED W1 `6947fd96`]

**File**: `packages/agentic-sdk-v2/src/store/agenticStore.ts:470-514`
**Severity**: Critical (compounding with C-1; also bites on single-instance
tenant-switch when the user reuses the tab for another tenant)

**Evidence (paraphrased per summary)**:
```typescript
clearOnLogout: () => {
  localStorage.removeItem('arcaai-preferences');
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('arcaai-user-preferences/')) removable.push(k);  // wipes ALL tenant-namespaced prefs
  }
  const open = indexedDB.open('arcaai-config');
  // deletes both 'user-preferences' and 'personalization' object stores wholesale
  for (const storeName of ['user-preferences', 'personalization']) { /* clear all */ }
}
```

Even though `user-preferences` keys are namespaced `${tenantId}::${userId}`,
the logout/switch path **iterates and removes every namespaced key**, not just
the active one. If tenant-B is impersonating from tenant-A's admin, or if two
users sign out at different times, you wipe storage that belongs to the user
still logged in.

**Attack / leakage scenario**

- Operator console mounts SDK for tenant-A and tenant-B in same tab. Tenant-A
  logs out. The clear wipes tenant-B's persisted preferences and IDB caches
  (transparent **denial-of-service** + forced re-download of all model caches).
- Impersonation stop → admin's own personalization cache is cleared because
  it shares the same `PERSONALIZATION_STORE` row (see C-3).

**Fix**:
- Scope the clear to the *outgoing* `(tenantId, userId)` only. Iterate
  `localStorage` keys but delete only the entry whose suffix matches the user
  that is logging out.
- Stop clearing the full `personalization` IDB store; clear only the active
  key (which should itself become per-user — see C-3).

**Effort**: Bare-minimum.

---

### C-3 — `PersonalizationManager` IndexedDB key is global, not per-user [CLOSED W1 `6947fd96`]

**File**: `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:20`
**Severity**: Critical

**Evidence**:
```20:20:packages/agentic-sdk-v2/src/core/PersonalizationManager.ts
const PERSONALIZATION_CACHE_KEY = 'arcaai-personalization';
```
```120:130:packages/agentic-sdk-v2/src/core/PersonalizationManager.ts
const cached = await configDBGet<UserPreferences>(PERSONALIZATION_STORE, PERSONALIZATION_CACHE_KEY);
```
```290:295:packages/agentic-sdk-v2/src/core/PersonalizationManager.ts
await configDBSet(PERSONALIZATION_STORE, PERSONALIZATION_CACHE_KEY, this.preferences);
```

By contrast, `USER_PREFERENCES_STORE` (used by `AgenticProvider` for the
ConfigManager cascade) correctly uses `makeIdbKey(${tenantId}::${userId})`:

```70:90:packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx
const prefs = await configDBGet<DeepPartial<AppConfig>>(USER_PREFERENCES_STORE, makeIdbKey(ns));
// ...
await configDBSet(USER_PREFERENCES_STORE, makeIdbKey(ns), prefs);
```

So one IDB store is properly namespaced and the other is not. `UserPreferences`
contains medical-workflow specific data: `workflowMode`, `language`,
`localConfig` (STT/VAD/NER model IDs, voice-profile thresholds), and crucially
`activeVoiceProfile { id, label, modelId, createdAt }` — which leaks a **voice
profile ID** that is tied to a specific doctor in `UserVoiceProfile` on the
backend.

**Attack / leakage scenario**

1. Doctor in tenant-A signs in on a shared workstation, enrols a voice profile.
   `PersonalizationManager` writes `activeVoiceProfile.id = "vp-A-…"` plus model
   selections to IDB under key `arcaai-personalization`.
2. Doctor signs out (cleanup only removes the cache key if `clearOnLogout`
   runs — and even then, see C-2 about over-eager clears causing the converse
   issue).
3. Doctor in tenant-B signs in on the same workstation. `PersonalizationManager`
   hydrates from the **same** key and is now pre-populated with tenant-A's
   voice-profile reference, NER model IDs, etc. The backend rejects mismatched
   IDs (good), but the SDK posts cross-tenant voice-profile IDs to the
   backend on every save, exposing them in logs/audit trails.
4. Conversely, if tenant-B writes first and tenant-A returns, tenant-A's
   data is silently overwritten.

**Fix**:
```typescript
// Inject namespace at construction time (mirrors USER_PREFERENCES_STORE pattern).
constructor(
  config: PersonalizationConfig,
  apiClient: AgenticClient,
  namespace: string,  // e.g. `${tenantId}::${userId}` from AgenticProvider
  logger?: ISDKLogger,
) {
  this.cacheKey = `arcaai-personalization/${namespace}`;
}
```

And rev `ARCAAI_CONFIG_DB_VERSION` to migrate / drop the old global row on
upgrade (one-time loss is acceptable; the backend remains authoritative).

**Effort**: Bare-minimum (one constructor parameter + a 3-line migration in
`configDB.ts`'s `onupgradeneeded`).

---

### C-4 — `SharedConnectionWorker` deduplicates WebSockets by `id` only (no userId) [CLOSED W3 `d9e961a5`]

**File**: `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts:84-115, 207`
**Severity**: Critical

**Evidence**:
```84:115:packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts
const sseConnections = new Map<string, ManagedSSE>();
const wsConnections  = new Map<string, ManagedWS>();

function sseDedupKey(id: string, userId: string | undefined): string {
  return `${id}::${userId ?? 'anon'}`;
}
```
```207:212:packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts
function handleWSSubscribe(port: MessagePort, id: string, sub: WSSubscription): void {
  const existing = wsConnections.get(id);  // <-- keyed on id only
  // ...
}
```

`SharedConnectionManager` (the client-side) also does not pass a user/tenant
discriminator on the WS subscribe path:

```191:202:packages/agentic-sdk-v2/src/core/SharedConnectionManager.ts
subscribeWS(id: string, subscription: WSSubscription, callbacks?: WSCallbacks): void { … }
```

While the SSE path correctly dedupes by `${id}::${userId}`, the WS path
collides any time two callers in different tabs (or the same tab, different
provider instance) share a logical subscription id. If two tenants set
`id = 'stt-stream'` or `id = pipelineId`, the SharedWorker reuses the **same
underlying WebSocket** for both, forwarding STT frames to whichever ports are
subscribed.

The risk is mitigated *somewhat* because every STT session also has a
server-minted `sessionId`/`ticket`, but the dedup id is what the SharedWorker
uses to decide whether to open a new socket — so if callers pass anything
other than the unique sessionId, collisions silently happen.

**Attack / leakage scenario**

- Multi-tab clinic UI: doctor in tenant-A and a separate user in tenant-B
  open consultations in the same SharedWorker scope (same browser profile,
  same origin). Both call `subscribeWS('asr-live', …)`. The second caller's
  subscription is hand-fed the first caller's open socket → transcript frames
  flow across tenants.
- Within a single tenant: two doctors using the same workstation with the
  same `pipelineId` as the subscription `id` get cross-stream contamination.

**Fix**:
1. Change `WSSubscription` to carry `userId` (and ideally `tenantId`).
2. Adopt the SSE dedup pattern in both `SharedConnectionWorker` and
   `SharedConnectionManager`:
   ```typescript
   function wsDedupKey(id: string, userId: string | undefined): string {
     return `${id}::${userId ?? 'anon'}`;
   }
   ```
3. Add a regression test mirroring `SimpleCrossTabSync.test.ts:497`
   ("cross-tenant should not leak").

**Effort**: Bare-minimum.

---

### C-5 — Tenant switch does not reset Zustand state [CLOSED W2 `15c3072a`]

**File**: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:527-560`
**Severity**: High

The provider has a `rehydrateUserNamespace` effect that depends on
`[effectiveUserId, effectiveTenantId, effectiveDepartmentId]` and reloads
the `ConfigManager` cascade + `PersonalizationManager` after a tenant change.
It also updates `AgenticClient.tenantId` synchronously on every render.

However, *no path* in this effect clears the singleton Zustand state for the
**outgoing** tenant:

- `store.consultation`, `store.contextItems`, `store.transcript`, `store.summary`
  remain populated with the previous tenant's data until the consumer
  explicitly calls a session-close hook.
- `store.modelRegistry` is rebuilt only when `loadTenantConfig` resolves —
  in the gap, components reading `modelRegistry` see tenant-A's catalogue.
- `store.authUser`, `store.authImpersonatedUser` straddle the swap.

**Attack / leakage scenario** — admin impersonation flow

1. Admin in tenant-A opens consultation X. Store now contains `consultation =
   {id, patientId: 'A-pat', tenantId: 'A', …}`.
2. Admin invokes impersonation of a user in tenant-B (in the same SDK
   instance; `AgenticClient.startImpersonation()` swaps the token via the
   `WeakMap`).
3. The provider re-renders with `effectiveTenantId = 'B'`. The cascade
   reloads, the IDB user-preferences key flips to the B namespace — **but**
   `store.consultation` still references patient `A-pat`. UI components rendering
   the patient header see tenant-A patient data under a tenant-B token. Any
   call referencing `store.consultation.id` posts to `/consultations/A-pat-id`
   while authed as B (backend correctly 403s, but the UI flashes A-PHI).

**Fix**: On detecting `effectiveTenantId` change, the `rehydrateUserNamespace`
effect should additionally call:
```typescript
store.setConsultation(null);
store.setContextItems([]);
store.setTranscript(null);
store.setSummary(null);
store.setModelRegistry(null);  // force re-init from new tenant config
```
…before the new tenant config resolves. Effort: Bare-minimum.

---

## D. Medium Findings

### D-1 — `STORAGE_KEYS.SELECTED_MODELS` in `ModelRegistry` is a global `localStorage` key [CLOSED W1 `6947fd96`]

**File**: `packages/agentic-sdk-v2/src/core/ModelRegistry.ts:466,480`; constants
in `packages/agentic-sdk-v2/src/core/constants.ts:361-364`.

**Evidence**:
```361:364:packages/agentic-sdk-v2/src/core/constants.ts
export const STORAGE_KEYS = {
  PREFERENCES: 'arcaai-preferences',
  SELECTED_MODELS: 'arcaai-selected-models',
} as const;
```
```462:480:packages/agentic-sdk-v2/src/core/ModelRegistry.ts
const stored = localStorage.getItem(STORAGE_KEYS.SELECTED_MODELS);
// ...
localStorage.setItem(STORAGE_KEYS.SELECTED_MODELS, JSON.stringify(this.selected));
```

Model selections (`{ stt?: string; vad?: string; ner?: string }`) persist
across tenants on the same browser. Risk classification is **medium** because:
- The values are model IDs (semi-public catalog), not PHI;
- The next `loadTenantConfig()` call overwrites them when defaults change;
- *However*, a custom tenant-private model ID listed only in tenant-A's
  `LOCAL_ASR_MODELS` GlobalSetting persists into tenant-B's session and the
  SDK silently attempts to download it. If that ID happens to be a Hugging
  Face hash or internal URL, it leaks across tenants via the next remote
  load.

**Fix**: Scope the key like personalization in C-3:
`localStorage.setItem(\`arcaai-selected-models/${namespace}\`, …)`.

**Effort**: Bare-minimum.

---

### D-2 — `STORAGE_KEYS.PREFERENCES` is also a global `localStorage` key [CLOSED W1 `6947fd96`]

**File**: `packages/agentic-sdk-v2/src/core/constants.ts:362`,
removed by `clearOnLogout` at
`packages/agentic-sdk-v2/src/store/agenticStore.ts:474`.

The summary indicates `arcaai-preferences` is referenced from the logout path,
implying there *is* a writer somewhere. Either:
- the writer is dead code (then remove it), or
- it persists user preferences in plain `localStorage` un-namespaced. Same
  bleed shape as D-1 but on a more sensitive blob.

**Fix**: Audit the writer; either delete it or namespace per
`${tenantId}::${userId}`. Effort: Bare-minimum.

---

### D-3 — Transformers.js model cache is not tenant-scoped [CLOSED W5 `db46a669`] [DEFERRED → 09 §2.1]

**File**: `packages/utils/src/transformers-cache.ts:18-26`

**Evidence**:
```18:30:packages/utils/src/transformers-cache.ts
export async function isTransformersModelCached(modelId: string): Promise<boolean> {
  // ...
  const transformersCaches = cacheNames.filter(name =>
    name.includes('transformers') || name.includes('huggingface')
  );
}
```

`Cache Storage` cache names (`transformers-cache`, `huggingface-*`) are
populated by Transformers.js automatically; the SDK doesn't currently
re-name them per tenant. Public model weights (Whisper, Silero) are fine,
but `TenantAudioConfig.localAsrModels` allows a tenant to publish custom
model entries — those weights cache cross-tenant.

**Recommendation**: For models whose `source: 'custom'`, prefix the cache name
(or store in a tenant-scoped sub-cache via `caches.open(\`vox/${tenantId}/transformers\`)`)
and clean orphans on tenant switch. Effort: Full.

---

### D-4 — SharedConnectionWorker HMAC secret is per-Worker, not per-tenant [CLOSED W3 `d9e961a5`]

**File**: `packages/agentic-sdk-v2/src/core/CrossTabHmacKeyManager.ts`

The HMAC key used to authenticate cross-tab messages is generated once per
SharedWorker session and is shared between all `BroadcastChannel` users in
that origin. Because `SimpleCrossTabSync` already namespaces channels by
tenant, cross-tenant messages cannot reach each other through the channel
boundary — but if anything ever subscribes to multiple channels with the
same Worker secret, a malicious sender could forge messages across tenants
inside the same browser.

**Recommendation**: Derive a per-tenant subkey: `HKDF(workerSecret, tenantId)`
and rotate on `setTenantId`. Effort: Full.

---

### D-5 — `SimpleCrossTabSync` not given `tenantId` from `useArcaSession` [CLOSED W3 `d9e961a5`]

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaSession.ts:88-92`

**Evidence**:
```88:92:packages/agentic-sdk-v2/src/hooks/useArcaSession.ts
crossTabSyncRef.current = createCrossTabSync({
  patientId: consultation.patientId,
  doctorId: consultation.doctorId,
  appointmentDate: consultation.appointmentDate,
});
```

`SimpleCrossTabSync` *supports* `tenantId` (channel becomes `agentic.<tenantId>`
when supplied), but the hook never passes it. The fallback is a SHA-256 hash
of `patientId_doctorId_appointmentDate` — usable, but if two tenants ever
share IDs (e.g. test fixtures, seeded data, or admin impersonation) the
channels collide.

**Fix**: Pass `tenantId` from `store.authUser?.tenantId` or
`store.apiClient?.getTenantId()` into the second argument
(`SimpleCrossTabSyncOptions`). Effort: Bare-minimum.

---

### D-6 — `AudioContextManager` is a process-wide singleton [CLOSED W5 `f2fbdcaf`]

**File**: `packages/room/src/core/AudioContextManager.ts:58-65`

```58:65:packages/room/src/core/AudioContextManager.ts
export class AudioContextManager {
  private static instance: AudioContextManager | null = null;
  private audioContext: AudioContext | null = null;
  private referenceCount = 0;
```

This is structurally correct (browsers limit AudioContext count) but combined
with C-1 it means audio frames flow through a context owned conceptually by
"whichever tenant last acquired it". Risk is low because audio is
acquired/released within a single consultation lifecycle, but worth knowing:
two `AgenticProvider`s in the same tab will fight over the singleton's
`referenceCount` and audio teardown can occur for the wrong tenant.

**Recommendation**: Document the constraint; consider raising
`RoomError(RoomErrorCode.MULTIPLE_PROVIDERS)` on second `acquire()` when a
debug flag is set so multi-instance bugs surface during development.

---

## E. Low / Hygiene Findings

### E-1 — Logger init failure falls back to `console.error` [CLOSED W5 `478c61b2`]

**File**: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:165`

```typescript
logger.initialize().catch((err) => {
  console.error('[AgenticProvider] Logger initialization failed:', err);
});
```

A logger-init failure bypasses configured Loki/Highlight/OTel transports.
Acceptable as a "logger isn't up yet" base case, but a configured Sentry-like
fallback would be nicer.

---

### E-2 — `selectedModels` JSON in `localStorage` not validated on read [CLOSED W1 `6947fd96`]

**File**: `packages/agentic-sdk-v2/src/core/ModelRegistry.ts:462-470`

`JSON.parse(localStorage.getItem(SELECTED_MODELS))` without schema validation.
A tampered entry can crash the manager on construction. Use `valibot`
(already a dep) to validate.

---

### E-3 — `LiveTranscriptionDemo` (apps/example) does not use the SDK [CLOSED W5 `6814c6fd`]

**File**: `apps/example/src/LiveTranscriptionDemo.tsx:1-309`

The example app is a *standalone* WS+fetch demo, not a vox consumer. It does
the right thing (passes `X-Tenant-ID`, `Authorization`), but it's misleading
to list it under "SDK examples". Either port it onto `<AgenticProvider>` or
rename it `apps/raw-ws-demo`.

---

### E-4 — `STT_V2_ENDPOINTS.WS_STREAM` path may be hardcoded without tenant claim [CLOSED W3 `d9e961a5`] [DEFERRED → 09 §2.1]

**File**: `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:149-160`

The client respects `wsUrl` from the session response and uses
`STT_V2_ENDPOINTS.WS_STREAM` as fallback. The fallback is acceptable because
the *ticket* re-asserts tenant identity server-side, but a defence-in-depth
improvement would be: refuse to open the socket if `tenantId` is missing
from the connect call (currently no such check).

---

### E-5 — Tests do not cover concurrent multi-`AgenticProvider` [CLOSED W4 `83f1db7b`]

There is no test under `packages/agentic-sdk-v2/src/**/__tests__/` that
mounts two providers with different tenants in the same render tree to
assert state isolation. Only `SimpleCrossTabSync.test.ts:497` includes a
"cross-tenant should not leak" case.

---

## F. Anti-patterns observed

| Anti-pattern in the audit checklist                              | Present? | Where                                                              |
| ---------------------------------------------------------------- | :------: | ------------------------------------------------------------------ |
| Module-level singleton state                                     |  **Yes** | `useAgenticStore` (store/agenticStore.ts)                          |
| `localStorage.getItem('…')` without tenant prefix                |  **Yes** | `STORAGE_KEYS.PREFERENCES`, `STORAGE_KEYS.SELECTED_MODELS`         |
| Audio tracks shared across instances                             |  partial | Implicit via `AudioContextManager` singleton; acceptable for browsers |
| WebSocket URL hardcoded without tenant query/path                |    No    | `wsUrl` + ticket from server                                       |
| React Context "global" instead of per-instance                   |  partial | `AgenticContext` is per-provider, but underlying store isn't       |
| Service workers caching cross-tenant responses                   |    No    | No SW in SDK; `transformers-cache` is the only shared cache (D-3)  |
| Build-time tenant config                                         |    No    | `tenantId` is runtime config                                       |
| Token in URL query                                               |    No    | Explicit comment forbidding it in `SSEClient.ts:135`               |

---

## G. Bare-minimum quick wins (5-10 items)

1. **Namespace `PERSONALIZATION_CACHE_KEY`** by `${tenantId}::${userId}` in
   `PersonalizationManager.ts:20`. Bump `ARCAAI_CONFIG_DB_VERSION` to 3 and
   drop the old global row on upgrade. *(Fixes C-3.)*
2. **Add `userId`/`tenantId` to WS dedup** in `SharedConnectionWorker.ts` &
   `SharedConnectionManager.ts` — mirror the existing `sseDedupKey` pattern.
   Add a regression test. *(Fixes C-4.)*
3. **Reset Zustand session slices on tenant switch**: in
   `AgenticProvider.tsx` `rehydrateUserNamespace`, call
   `store.setConsultation(null); store.setContextItems([]);
   store.setTranscript(null); store.setSummary(null);
   store.setModelRegistry(null);` before reloading the new tenant config.
   *(Fixes C-5.)*
4. **Scope `clearOnLogout`** in `agenticStore.ts` to the *outgoing* user's
   keys only — never iterate-and-delete all `arcaai-user-preferences/*`
   entries, only the active one. *(Fixes C-2.)*
5. **Namespace `STORAGE_KEYS.SELECTED_MODELS`** in `ModelRegistry.ts` —
   `arcaai-selected-models/${namespace}`. *(Fixes D-1.)*
6. **Pass `tenantId` to `createCrossTabSync`** in
   `useArcaSession.ts:88` from `store.apiClient.getTenantId()`. *(Fixes
   D-5.)*
7. **Audit/remove or namespace `STORAGE_KEYS.PREFERENCES`** writer.
   *(Fixes D-2.)*
8. **Add valibot validation** on `localStorage` JSON reads in `ModelRegistry`.
   *(Fixes E-2.)*
9. **Refuse to open WS without tenantId**: defensive check in
   `SttV2WebSocketClient.connect()` (E-4).
10. **Add a dev-mode warning** in `AudioContextManager.acquire()` when
    `referenceCount > 1` with different `tenantId` callers. *(D-6.)*

---

## H. Strategic improvements

1. **Make Zustand store per-`AgenticProvider`.** Export
   `createAgenticStore()` factory; hold instance in provider via `useRef`;
   expose via React context; migrate every hook to a `useStoreApi()` helper.
   This is the only true fix for **multi-instance concurrent operation**.
   *(Fixes C-1 and unlocks proper multi-tenant operator consoles.)*
2. **Unified namespaced-storage utility.** Replace direct
   `localStorage`/`indexedDB.open` calls with a wrapper that *requires* a
   `(tenantId, userId)` tuple. Build it on top of `configDB.ts` so the
   schema migration is centralised.
3. **Multi-instance integration test suite** (Playwright + Vitest):
   - two providers, two tenants, same tab, parallel STT streams
   - tenant switch mid-consultation
   - impersonation start → stop with personalization assertions
   - SharedWorker cross-tab WS isolation
4. **Per-tenant HMAC key derivation** in `CrossTabHmacKeyManager` (D-4).
5. **Tenant-scoped Cache Storage** for Transformers.js custom-model weights
   (D-3).
6. **Document the multi-tenant contract** in `packages/agentic-sdk-v2/README.md`
   so SDK consumers know:
   - one `AgenticProvider` per tab is currently supported,
   - tenant switch requires explicit `store.reset()`,
   - hosting two tenants in the same tab is a future-roadmap item gated on
     items 1-3 above.

---

## I. Positive observations

- **`X-Tenant-ID` header is always set** when `tenantId` is configured
  (`AgenticClient.ts:197-198`) and cleared on logout
  (`AgenticClient.ts:844-851`).
- **Impersonation token is held in a `WeakMap`** (`AgenticClient.ts:30-31`),
  preventing the original admin JWT from leaking into serialised state or
  store snapshots. The `useAuth` flow correctly toggles
  `PersonalizationManager.setImpersonationReadOnly(true)` during impersonation
  to block writes to the impersonated user's prefs.
- **One-shot stream tickets** for WebSocket and SSE
  (`SttV2WebSocketClient.ts:158-160`, `SSEClient.ts:135`) — explicit
  comment forbids JWT in URL. This is the right pattern for streaming auth.
- **`SimpleCrossTabSync` channels are tenant-namespaced**
  (`SimpleCrossTabSync.ts:194-199, 263-267`), including a fallback hash of
  the consultation key when tenantId is unknown.
- **HMAC signing of cross-tab messages** (`CrossTabHmacKeyManager.ts`) makes
  it hard for a malicious page in the same origin to inject context items
  into another tab's session.
- **Comprehensive PHI redaction** in the logger
  (`packages/agentic-sdk-v2/src/core/logger/redactor.ts`) — `redactPHI` and
  `PHI_KEYS` cover transcript text, names, DOB, etc. Highlight transport
  redacts `authorization`/`x-api-key`/`cookie` headers (highlight.transport.ts:139-146).
- **Tenant context appears in every log entry** via `entry.user.tenantId`,
  exported to all transports (Loki, OTel, Highlight, console).
- **Per-tenant `loadTenantConfig`** seeds default model selections from
  `/tenant/me/config` (ModelRegistry / TenantAudioConfig), so tenants can
  enforce their own model whitelist server-side.
- **`USER_PREFERENCES_STORE` IDB rows are properly namespaced**
  (`AgenticProvider.tsx:70, 89`) via `makeIdbKey(${tenantId}::${userId})` —
  the architecture *knows* how to do this; the gap is just that
  `PERSONALIZATION_STORE` didn't get the same treatment.
- **Playground `sessionStorage` choice** (`apps/ui-playground/src/store/auth-store.ts:131-135`)
  with `partialize` excluding impersonation state is a good security default
  for the dev harness.
- **`SSEClient` explicitly documents** why JWT is not in the URL — the kind
  of inline rationale that ages well.

---

## Summary

`@arcaai/vox` is **safely multi-tenant-aware in the single-instance,
single-active-tenant per tab case** that the playground exercises. The
network layer (headers, tickets, HMAC) is solid. The four critical gaps are
all in browser-side persistence and the cross-instance / cross-tenant-switch
plumbing:

1. The Zustand store is a module singleton → no real isolation between
   concurrent providers.
2. Tenant switch does not reset stale session state.
3. The `personalization` IndexedDB row is keyed globally.
4. The SharedWorker dedupes WebSockets by `id` only — cross-tab WS leakage.

The first three are bare-minimum fixes (small diffs, mostly mechanical). The
fourth needs a `WSSubscription` schema change but is also small. Until those
are addressed, **`@arcaai/vox` should not be used in browser scenarios where
multiple tenants can be active concurrently in the same tab, and tenant
switching mid-session should be paired with a hard page reload.**

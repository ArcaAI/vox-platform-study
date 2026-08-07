# TASK-631 — Unified cache-invalidation bus

| Field | Value |
|---|---|
| **Status** | `Pending` — plan only, no code written |
| **Type** | `refactor` (cross-cutting infrastructure) |
| **Raised by** | TASK-610 §1 follow-up — the config fetch/cache/refresh review |
| **Blast radius** | `SecretsService` (Vault rotation), `AppSettingsService` (read by nearly everything) |

---

## 1. Why this is a ticket and not a follow-up commit

It was raised as "collapse the three invalidation channels into one" at the end of TASK-610. It is
deliberately NOT being done there. The two Redis channels live in the two most load-bearing runtime
services in the platform, they carry **different payloads and different semantics**, and a regression
in either is silent until something stale hurts someone:

- a missed **secret** invalidation means a rotated credential is not picked up — auth failures, or
  worse, a revoked credential still honoured until the 45 s backstop;
- a missed **settings** invalidation means a kill-switch an operator just flipped does not take
  effect on some nodes.

Neither failure throws. Both look fine in tests. That combination is what earns a plan.

## 2. Current state — three lanes, two transports

| Lane | Transport | Publisher | Subscriber | Payload | Semantics |
|---|---|---|---|---|---|
| `app-settings:invalidate` | Redis pub/sub | `AppSettingsService` after a `GlobalSetting` write | `AppSettingsService` on every node | `{ instanceId }` | "drop everything and re-read"; `instanceId` exists ONLY to suppress the publisher's own echo |
| `arca:secrets:invalidate` | Redis pub/sub | `vault-rotation-worker` on a kv-v2 write | `SecretsService` | `{ key }` | "this ONE key rotated" — targeted, not a full flush |
| `origin-registry.invalidate` | in-process `EventEmitter2` | `TenantAllowedOriginService` after a mutation | `OriginRegistryService` | none | same-node only; peers converge via the settings lane + a 30 s cron |

Two observations that shape the design:

1. **They are not the same shape.** One is a broadcast flush with self-echo suppression, one is a
   targeted single-key notice, one is in-process only. "Collapse into one channel" must not mean
   "flatten into one meaning" — a full flush on every secret rotation would be a regression.
2. **The third lane is a different problem.** `origin-registry.invalidate` is in-process because it
   has no cross-node story at all; it rides the settings lane by accident. Giving it a real
   cross-node lane is arguably more valuable than merging the other two.

## 3. What actually hurts today

- **Two Redis subscriber connections** and two hand-rolled subscribe/reconnect paths. Each is a place
  to get resubscribe-after-reconnect wrong, independently.
- **Self-echo suppression is implemented once**, in `AppSettingsService`. Any future lane has to
  re-derive it, and getting it wrong causes an infinite refresh loop between two nodes.
- **No shared observability.** There is no single answer to "when did this node last converge?" Each
  cache reports success in its own way, and TASK-610 already established that a
  success-only signal cannot bound staleness.
- **No delivery guarantee anywhere.** Redis pub/sub is fire-and-forget: a node that is down, paused,
  or reconnecting during the publish simply misses it and stays stale until its own TTL backstop. All
  three lanes rely on that backstop being correct — and TASK-610 found one that was refreshing an
  index nobody read.

## 4. Proposed design

A single `CacheInvalidationBus` in `packages/applications/src/services/baseServices/`, owning ONE
Redis subscriber and a typed envelope:

```ts
interface InvalidationEvent {
  domain: 'app-settings' | 'secrets' | 'origin-registry' | string;
  /** Absent = flush the whole domain. Present = that key only. */
  key?: string;
  /** Publisher's instance id — the bus drops self-echo centrally, once. */
  origin: string;
  at: string;
}
```

Consumers register a handler per domain. The bus owns: subscribe, **resubscribe on reconnect**,
self-echo suppression, structured logging, and a per-domain `lastConvergedAt` that a health endpoint
can expose.

**Semantics are preserved, not merged.** `secrets` keeps its targeted `key`; `app-settings` keeps its
full flush. The bus unifies TRANSPORT and PLUMBING, not meaning.

**`origin-registry` gains a real cross-node lane**, removing its accidental dependence on the settings
cron and shrinking its worst-case staleness from ~60 s to sub-second.

## 5. Implementation order (each step independently shippable and revertible)

1. Build the bus with no consumers. Unit tests: envelope, self-echo drop, reconnect resubscribe.
2. Migrate `origin-registry` first — **lowest risk**, in-process today, and the one that gains most.
3. Migrate `app-settings`. Run both lanes in parallel for one release (publish to both, subscribe to
   the bus) so a rollback is a config flip rather than a revert.
4. Migrate `secrets` **last**, and only after the bus has run a release in production. Rotation is the
   one lane where a silent miss is a security event.
5. Delete the old channels once metrics show zero traffic on them.

## 6. Explicit non-goals

- Not replacing the TTL/cron backstops. Pub/sub is best-effort; the backstop is what makes staleness
  bounded. TASK-610 §4A established that a backstop must fire on the FAILURE path too — that property
  must survive this refactor untouched.
- Not changing any cache's fail-open/fail-closed posture.
- Not introducing a message broker. Redis pub/sub with a correct backstop is proportionate; durable
  delivery is a different (and much larger) conversation.

## 7. Acceptance

- One Redis subscriber connection for invalidation across the gateway.
- Self-echo suppression implemented exactly once, with a test proving two nodes cannot ping-pong.
- Each domain exposes `lastConvergedAt`; a stalled lane is visible without reading the database.
- Secret rotation verified end-to-end against a live Vault before the old channel is deleted.
- Every existing backstop still fires on the failure path.

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-07 | Raised from the TASK-610 config review. Plan only — deliberately not implemented in TASK-610, see §1. |

# TASK-940 — Live-Documentation Env Surface: Declaration and Tiering

| | |
|---|---|
| **Status** | Completed |
| **Type** | refactor / infrastructure |
| **Branch** | `dev-2.2` |
| **Base** | `8320ea15c` |
| **Ancestry** | TASK-939 OD-6 ("declare the rest in `turbo.json#globalEnv` and leave the migration to a config-governance ticket"); TASK-870 Configuration Governance Program (Review) |
| **Owner decisions** | 5, all answered as recommended (2026-09-10). ONE evidence-driven deviation on OD-3 — §4 |

## 1. Requirement Analysis

`LiveDocumentationService` reads **18 distinct environment variable names** that appear in
**none** of the generated artifacts: not `turbo.json#globalEnv`, not `.env.sample`, not
`env-surface.generated.md`. `pnpm env:sync:check` passes anyway, so no gate in the repo can
currently falsify "the live-documentation config surface is declared".

Three questions, per variable: is it still read at all; is it bootstrap-tier env at all; and
whatever survives as env must end up **declared by a mechanism the generator owns**, because a
hand edit to `turbo.json` is reverted by the next `pnpm env:sync`.

### Measured baseline (2026-09-10, `cbbe5c257`)

```
$ pnpm env:sync:check
env:sync --check OK — 12 artifacts match their declarations
  (142 TS keys + 308 Python fields · 486 globalEnv entries);
  no unread keys in 7 operator-facing files.

$ python3 -c "import json;print([k for k in json.load(open('turbo.json'))['globalEnv'] if k.startswith('LIVE_DOC')])"
[]
```

**A counting correction to the brief.** `grep -o "LIVE_DOC_[A-Z_]*"` reports 17 distinct names,
but two of them are not environment variables: `LIVE_DOC_CONTEXT_TYPES` is a local `Set` of
context-item types (`:208`) and `LIVE_DOC_GROUNDEDNESS_ENABLED_KEY` is the imported
descriptor-key constant (`:187`). The real env surface is **15 `LIVE_DOC_*` + 3
`AGENTIC_CONTEXT_*` = 18**.

## 2. Current State Evaluation

### 2.1 Why the generator cannot see them — two independent mechanisms, confirmed

The brief's hypothesis is correct, and it is only half of the cause.

**Mechanism A — the scanner matches a syntax these reads do not use.** `scanTypeScriptReads()`
(`scripts/env-sync.mts:874-891`) matches exactly one shape:

```js
const READ = /process\.env(?:\.([A-Z][A-Z0-9_]{1,})|\[\s*['"`]([A-Z][A-Z0-9_]{1,})['"`]\s*\])\s*(=[^=]|$|[^=])/g;
```

Every read in this service goes through Nest's `ConfigService` instead —
`this.configService.get('LIVE_DOC_HEARTBEAT_MS')` — or through one of two local helpers that
take the key as a parameter (`readNumericEnv(this.configService, 'LIVE_DOC_SEGMENT_THRESHOLD')`,
`:670-687`). Neither contains the token `process.env`, so the regex cannot match. This is the
same class of invisibility the generator's own header describes for Python
(`os.getenv` via "one-line helper indirection"), which the Python side solved with an AST pass;
the TypeScript side never grew the equivalent.

**Mechanism B — even a DECLARED descriptor does not contribute its env name.** Eight of the
eighteen are already governed by a registry descriptor, with env kept as a deliberate override.
But the generator folds only `ENV_SUPPLIED_TIERS = {'env', 'vault-kv'}` into the declared
surface (`:113`, `:350`), and every one of those descriptors is tier `global-kv` — correctly so,
since rendering a control-plane key into `.env.sample` is the drift the generator exists to
remove. There is therefore **no mechanism at all today** by which a `global-kv` descriptor's
legacy env override reaches `globalEnv`. Note too that these override names are legacy and are
*not* derivable: `agentic.context.liveFlush.idleMs` is overridden by `LIVE_DOC_DEBOUNCE_MS`,
which `toEnvVarName()` would never produce.

Fixing A alone leaves B, and fixing B alone leaves a genuinely env-tier read invisible. Both
are in scope.

### 2.1a The blindness is not confined to live-documentation — measured

Prototyping the two Lane-1a shapes against the whole non-test TypeScript tree, with the same
`[A-Z][A-Z0-9_]+` filter the existing regex uses:

| Shape | Distinct names | Already in `globalEnv` | **Undeclared** |
|---|---|---|---|
| `configService.get('NAME')` / `.get<T>('NAME')` | 18 | 4 | **14** |
| `readNumericEnv/readBooleanEnv(configService, 'NAME')` | 7 | 0 | **7** |
| **Total** | | | **21** |

Eighteen of those 21 are live-documentation's. **Three are not**, and all three are live reads
that decide behaviour today:

| Name | Reader | What it does | Tier judgement |
|---|---|---|---|
| `HARNESS_BASE_URL` | `apps/api/src/modules/harness-admin/harness-ops.client.ts:103` | overrides the harness base URL ahead of `HARNESS_URL` | topology — legitimately env, merely undeclared |
| `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED` | `packages/applications/src/services/directory-sync/google-directory.provider.ts:47` | kill-switch, default OFF; throws `BadRequestException` when off | kill-switch — `redis-flag` shape, env today |
| `TENANT_IDP_MS_GRAPH_ENABLED` | `.../ms-graph-directory.provider.ts:40` | same, for MS Graph | same |

So the generator has been blind across three unrelated subsystems, not one service, and
`HARNESS_BASE_URL` is the clearest proof that the gap hides ordinary bootstrap-tier topology too
— not just control-plane knobs that arguably should not be env at all. That is the argument for
Lane 1a being the substance of this ticket rather than a supporting change. Only these two
shapes were prototyped; the helper list is exactly `readNumericEnv` / `readBooleanEnv`, so there
is no third indirection to chase in TypeScript today.

### 2.2 Per-variable disposition (all 18)

**(a) Already governed by a descriptor; env is an override — 8.** These need *declaration only*,
no behaviour change.

| Env name | Governing descriptor | Tier |
|---|---|---|
| `LIVE_DOC_SEGMENT_THRESHOLD` | `agentic.context.liveFlush.segmentThreshold` | `global-kv` |
| `LIVE_DOC_DEBOUNCE_MS` | `agentic.context.liveFlush.idleMs` | `global-kv` |
| `LIVE_DOC_MIN_INTERVAL_MS` | `agentic.context.liveFlush.minIntervalMs` | `global-kv` |
| `AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS` | `agentic.context.liveDelta.maxChars` | `global-kv` |
| `AGENTIC_CONTEXT_TOKEN_BUDGET_PER_RUN` | `agentic.context.tokenBudget.perRun` | `global-kv` |
| `AGENTIC_CONTEXT_TRANSCRIPT_MODE` | `agentic.context.transcript.mode` | `global-kv` |
| `LIVE_DOC_TEXT_TIMEOUT_MS` | `consultation.realtime.textTimeoutMs` | `global-kv` |
| `LIVE_DOC_GROUNDEDNESS_ENABLED` | `liveDoc.groundedness.enabled` | feature-availability |

> `LIVE_DOC_MIN_INTERVAL_MS` is the TASK-939 R7 migration the brief cites as precedent. It was
> uncommitted when this survey began and landed mid-survey as `8320ea15c` — see §2.4.

**(b) Constructor freeze, no descriptor — 7.** Read once in the constructor, so changing any of
them needs a redeploy. These are the substantive migration candidates.

| Env name | Line | Code default | What it governs |
|---|---|---|---|
| `LIVE_DOC_HEARTBEAT_MS` | `:1021` | 15000 | heartbeat emission interval |
| `LIVE_DOC_DURABLE_SNAPSHOT_MS` | `:1032` | 30000 | durable-snapshot throttle (0 disables) |
| `LIVE_DOC_TEXT_MAX_TOKENS` | `:1034` | 8192 | `max_tokens` on every live TEXT call |
| `LIVE_DOC_STATS_TTL_SEC` | `:1045` | 300 | Redis stats-snapshot TTL / admin "live" window |
| `LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS` | `:1059` | 5000 | groundedness call timeout |
| `LIVE_DOC_GROUNDEDNESS_MAX_RETRIES` | `:1060` | 1 | groundedness bounded retry |
| `LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS` | `:1061` | 200 | groundedness retry backoff |

**(c) Kill-switch with a runtime override already in place — 1.** `LIVE_DOC_ENABLED` (`:1023`)
is the boot default behind a Redis override: `isEngineEnabled()` returns
`this.engineEnabledOverride ?? this.enabled` (`:5749-5751`), refreshed from
`cacheService` (`:5754`). That is the sanctioned `redis-flag` shape from
`09-infrastructure-devops.md` §Configuration Tiers — the value *can* change without a restart,
through the tier meant for it. Its env half is a legitimate boot default and should stay env,
declared. (Whether a kill-switch may default **on** is a pre-existing question this ticket does
not open.)

**(d) Dead in every deployed path — 2.** `LIVE_DOC_TEXT_PROVIDER` and `LIVE_DOC_TEXT_MODEL`
(`:1040-1041`) are read into fields that are then **unconditionally overwritten** at all three
call sites:

```ts
let provider = this.textProvider;
let model = this.textModel;
if (this.harnessPolicyService) ({ provider, model, generation } = await this.harnessPolicyService.resolveTextSelection(tenantId, 'live'));
```
(`:4702-4706`, `:4961-4964`, `:5062-5065`)

`harnessPolicyService` is `@Optional()` (`:892`), but the service module imports
`HarnessPolicyServiceModule` (`live-documentation.service.module.ts:67`), so in the real DI graph
the branch *always* taken is the one that discards the env value. The surviving fallback is
reachable only from a hand-constructed, non-DI instance — i.e. tests.

This is not merely dead, it is **dead against a stated rule**. The comment immediately above one
of those sites says so in as many words:

> "provider/model SELECTION is never substituted with an env default — the tenant's assigned
> TEXT_GENERATION agent selects (TASK-876; the node `llmBinding` is retired)."

And `09-infrastructure-devops.md` §"No hardcoded configuration" makes it a rule rather than a
preference: an engine or model id is not an env var. Declaring these two into `globalEnv` would
be documenting a config input that cannot influence any deployment — and would poison the cache
key to do it.

Tally: 8 + 7 + 1 + 2 = **18**.

### 2.3 Cache-key consequence (not free)

`globalEnv` names are hashed into turbo's cache key for *every* task, so each name added is a
real change to cache behaviour, not bookkeeping. The generator's own `NOT_CONFIGURATION`
docblock (`:406-422`) is explicit that the cost is the point of the list:

> "`globalEnv` hashes each variable's VALUE into the turbo cache key, so a name whose value
> legitimately differs between two shells on the same machine does not 'declare a config input',
> it destroys cache hits."

Expected effect of this ticket, by disposition:

- **(a) 8 + (c) 1 = 9 names added.** These are genuine config inputs: their value changes what
  the gateway does, and today a change to one of them does **not** invalidate any cached task.
  That is a correctness bug in the cache key, and closing it costs cache hits exactly when one
  of these values actually differs between runs — which is the intended behaviour.
- **(b) 7 names**, if they keep an env override (OD-3), add 7 more on the same argument. If the
  env names are retired instead, they add 0 and the knobs become uncacheable-by-construction
  because they live in the database.
- **(d) 2 names add nothing** — deleting the reads is strictly cache-positive.

Net, under the recommended answers: **+19 entries** (9 from (a)+(c), 4 from (b) per OD-3, 3 from
the non-live-doc reads of §2.1a, minus 0 from (d) which were never declared), **486 → ~505**. A
CI cache cold-start on the first pipeline after merge is expected and is not a regression.

Two gates also move and must be bumped deliberately rather than discovered:
`scripts/__tests__/env-sync.test.ts:342` holds the declared TS surface to `<= 155` (currently
142), and `:293` documents every prior bump with its reason. Whatever lands here gets the same
treatment — a bump with the count and the reason, in that comment block.

### 2.4 Collision risk — a second writer is active in this checkout

When this survey began, `live-documentation.service.ts` and `agentic-context.descriptors.ts`
carried **uncommitted** TASK-939 R7 edits (the `minIntervalMs` migration). They were committed
mid-survey as `8320ea15c`, so **both files are now clean and the R7 precedent is in `HEAD`** —
this ticket's base was moved to that commit accordingly.

The TASK-939 lane is nonetheless **still active in this same checkout**: as of writing it holds
uncommitted work in `consultation.controller.ts`, the `document-section` service and
`route-manifest.json`, plus two untracked test helpers. None of those is a file this ticket
plans to touch, so there is no live conflict — but per `14-multi-agent-worktrees.md` §3 the
overlap is a property to re-verify immediately before each lane, not once at the start. The
sequencing question in OD-1 is therefore softer than it looked, and its answer should still be
driven by where the defect actually is rather than by file availability.

## 3. Implementation Plan (on go)

Lanes are ordered so that each is independently verifiable, and so the one that touches the
contested file comes last.

### Lane 1 — teach the generator to see the reads (no behaviour change)

Two changes, because §2.1 found two mechanisms.

**1a. Scanner (Mechanism A).** Extend `scanTypeScriptReads()` to recognise `ConfigService`
reads alongside `process.env`:

- `configService.get('NAME')` / `.get<T>('NAME')` — SCREAMING_SNAKE literals only, the same
  `[A-Z][A-Z0-9_]{1,}` filter the existing regex uses, so a dotted settings key can never be
  mistaken for an env name.
- the helper-indirection shape, `readNumericEnv(<expr>, 'NAME')` / `readBooleanEnv(...)` — a
  named list of env-reader helpers, mirroring what `python-env-surface.py` already does for
  one-line helpers on the Python side.

Same exclusions as today (tests, `docs/`, `DOCUMENTATION_SURFACES` template literals). Unit
tests in `scripts/__tests__/env-sync.test.ts`: each new shape is detected; a dotted key is not;
a `.get()` on a non-ConfigService receiver is not.

**1b. Declaration (Mechanism B).** Add an optional `envOverride?: readonly string[]` to
`SettingDescriptor`, and fold `descriptor.envOverride` into `computeGlobalEnv()` for **every**
tier — not just the env-supplied ones. It deliberately does **not** render into `.env.sample`:
the value's home is the control plane, and the env name is a legacy override being kept alive,
not an operator-facing setting. Declare the 8 names of §2.2(a) on their governing descriptors.

This makes the override relationship a declared fact in one place, which is also what makes its
eventual retirement visible — today the pairing exists only as a comment in a constructor.

**Verify:** `pnpm env:sync` produces a `turbo.json` diff containing exactly the expected names;
`pnpm env:sync:check` green; the `env-sync.test.ts` ceiling bumped with its reason.

### Lane 2 — delete the two dead provider/model reads (§2.2(d))

Remove `this.textProvider` / `this.textModel`, their two constructor reads, and the three
`let provider = …` seeds, leaving `resolveTextSelection` as the only source — which is what
every deployed path already does. A test pins that a hand-constructed instance with no
`harnessPolicyService` no longer picks up an env provider/model, so the deletion cannot be
quietly undone.

Touches `live-documentation.service.ts` → **gated on OD-1**.

### Lane 3 — tier the seven constructor freezes (§2.2(b))

Per OD-2/OD-3, add `global-kv` descriptors and a resolution point. The three groundedness knobs
and `textMaxTokens` have a natural one (the per-flush resolve that `minIntervalMs`,
`textTimeoutMs` and `groundednessEnabled` already use). `heartbeatMs`, `durableSnapshotMs` and
`statsTtl` do **not** — they parameterise timers created at session start, so making them
governed means re-reading at start (next session picks up the change) rather than per flush.
That difference is real and is why OD-2 exists.

Touches `live-documentation.service.ts` → **gated on OD-1**.

### Lane 4 — documentation

Ticket README (this file) with the final numbers; `docs/operations/deprecation-register.md`
entry for the retired `LIVE_DOC_TEXT_PROVIDER` / `LIVE_DOC_TEXT_MODEL` names and for any env
override Lane 3 retires.

### Verification (every lane)

```
pnpm env:sync:check
pnpm --filter @arcaai/applications build test
pnpm typecheck:all
```

Plus `pnpm --filter hope-monorepo test` for `scripts/__tests__/env-sync.test.ts` on Lane 1.
Per `01-development-workflow.md` §Test Scope Exclusions, failures from `packages/ui`,
`apps/compat-playground` and `apps/quick-compat-app` are out of scope and reported as such.

## 4. Owner Decisions (open — nothing is implemented until these are answered)

| Id | Question | Recommendation |
|---|---|---|
| **OD-1** | **Sequencing against the still-active TASK-939 lane** (§2.4 — the two files this ticket needs went clean mid-survey, but that lane is still writing elsewhere in this checkout). Options: (a) Lane 1 first, then 2-3, re-checking the tree before each; (b) all four lanes now; (c) wait for TASK-939 to close entirely | **(a)**. Not primarily for collision reasons any more — `live-documentation.service.ts` is clean — but because Lane 1 is where the actual defect is (a gate that cannot fail) and it lands the declaration mechanism Lanes 2-3 then consume. Doing Lane 3 first would mean declaring knobs by a mechanism that does not exist yet |
| **OD-2** | **Do the 7 freezes become governed, or stay declared env?** Governing them is the rule-correct answer, but three of them (`heartbeatMs`, `durableSnapshotMs`, `statsTtl`) have no per-flush resolution point and would take effect only on the next session | Govern all 7, with the honest granularity: per-flush for the 4 that have one, next-session for the 3 that do not, each documented on its descriptor. A knob that changes on the next consultation is still a redeploy avoided |
| **OD-3** | **Does a governed knob keep its env name as an override?** The existing precedent (`minIntervalMs`, `textTimeoutMs`, `groundednessEnabled`) keeps it, seeded in the constructor so the value before the first resolve matches what that resolve would return | Accepted as recommended (keep 4, retire 3) — **implemented as keep 5, retire 2.** See the deviation note below |

### Deviation from OD-3 (evidence-driven, 2026-09-10)

The accepted answer retired `LIVE_DOC_DURABLE_SNAPSHOT_MS` along with `LIVE_DOC_HEARTBEAT_MS`
and `LIVE_DOC_STATS_TTL_SEC`, on my evidence that "nothing sets any of the 7". **That evidence
was incomplete: it scanned env files and the cluster manifests, not test fixtures.** Retiring the
name broke two tests in `live-documentation.service.test.ts`, which is how it surfaced.

Three fixtures set `LIVE_DOC_DURABLE_SNAPSHOT_MS` — `live-documentation.service.test.ts` ×2 at
`'1000'` to exercise the throttle, and `live-documentation.governed-graph-mode.task858.test.ts`
at `'0'`, which is a MEANINGFUL value here (it disables periodic durable writes). Decisively,
the harness they use passes `undefined` for `effectiveSettings`, so retiring the env name would
have left that knob with **no lane at all**, not one fewer — and "the fallback for an unwired
settings graph" is the exact reason the `textTimeoutMs` exemplar kept its own env var.

So `durableSnapshotMs` keeps its override and the split is 5/2. `heartbeatMs` and `statsTtlSec`
are set by no deployment **and** no fixture, and were retired as decided. Net effect on the
estimate: 503 entries rather than 502.

Flagging rather than silently absorbing this, because it changes an answer the owner gave — and
because the lesson generalises: a "nothing reads this" claim about an env var has to include
fixtures, or it is a claim about production only.
| **OD-4** | **Scope of the Lane 1a scanner change.** Measured: the scanner change surfaces **21** undeclared reads, **3 outside live-documentation** (§2.1a). Fix all of them here, or declare them and file the tiering separately? | **Declare all 21 here** — leaving a known undeclared read is exactly how this defect survived a passing gate. But only live-documentation gets *tiered* in this ticket: `HARNESS_BASE_URL` is already correctly env-tier and needs nothing but a declaration, and the two `TENANT_IDP_*` kill-switches are a separate decision on a separate subsystem — file that under TASK-870. **DONE:** filed 2026-09-10 as TASK-870 owner item 12, with the shape recommendation and the reason it is a SCOPE defect rather than a tier label (a platform-wide switch over per-tenant work). One correction to this recommendation as written: I called them "`redis-flag`-shaped", and on reading the consumers that is the weaker read — `DirectorySyncService.enqueueSync(tenantId, providerId)` runs on tenant-provisioned credentials, so the shape is a per-tenant feature gate (`global-kv` at `maxScope: 'tenant'`, i.e. `FEATURE_AVAILABILITY_SETTINGS`), not a platform kill-switch |
| **OD-5** | **Ticket identity.** TASK-940 standalone, or a lane inside TASK-870 (Configuration Governance Program, status Review)? | **TASK-940 standalone.** TASK-870 is in Review and its scope is the 341-descriptor model, not generator detection. TASK-939 OD-6 explicitly deferred this to "a config-governance ticket" — this is it, cross-referenced both ways |

## 5. Implementation Summary

All four lanes landed. `globalEnv` **486 → 503**.

| Commit | Lane |
|---|---|
| `60ba17662` | 1 — the generator sees `ConfigService` reads; `SettingDescriptor.envOverride` |
| `f22b20732` | 2 — the two dead provider/model reads deleted |
| (this commit) | 3 + 4 — the seven freezes tiered; deprecation register |

### What changed, by lane

**Lane 1a — the scanner.** `TS_CONFIG_SERVICE_READERS` (`get`, `getConfigValue`) matches on
receiver NAME plus a SCREAMING_SNAKE key, and `TS_CONFIG_SERVICE_KEY_SECOND_HELPERS`
(`readNumericEnv`, `readBooleanEnv`) covers the shape where the key is argument TWO — which is
why the pre-existing `TS_ENV_HELPERS` list, anchored on argument ONE, never rescued these. The
name filter is the safety mechanism, not a deny-list: tests pin that `sessions.get('X')` and a
dotted `agentic.context.*` key both stay out of the cache key. `getConfigValue` added **zero**
names (all 8 of its SCREAMING_SNAKE keys were already declared) and is in as a backstop.

**Lane 1b — `SettingDescriptor.envOverride`.** Folded into `computeGlobalEnv()` for every tier,
rendered into no `.env.sample`: reads there, declarations nowhere else. A test forbids it on an
`env`/`vault-kv` descriptor, where the key's own name already IS the declaration.

**Lane 2 — deletion, not declaration.** `LIVE_DOC_TEXT_PROVIDER` / `LIVE_DOC_TEXT_MODEL` gone,
with the three call sites now declaring `let provider: string | undefined` so an unwired resolver
leaves selection to TEXT's own default instead of a pinned engine.

**Lane 3 — seven `consultation.realtime.*` descriptors.** Built through one `budget()` mapper so
the shared half (tier, scope, `failMode`) is identical by construction, and resolved as one batch
by `resolveRealtimeBudgets(tenantId)` on the flush path beside the `textTimeoutMs` /
`groundednessEnabled` siblings. Assigned once per flush, so no consumer can observe a
half-updated set. Defaults are byte-identical to the constructor literals they replace.

Two implementation details worth recording:

- **The groundedness trio is mutated in place**, not re-passed. `LiveToolRegistry` captures its
  dependency bundle by identity in a session's frozen tool plan, so reassigning a field on the
  service would never reach a plan already built — the same mechanism `toolEnvDefaults` already
  uses for the groundedness GATE. First attempt passed getters and failed to typecheck against
  the registry's `number` contract, which is what surfaced the constraint.
- **`??` is load-bearing on `durableSnapshotMs`.** `0` is a meaningful value (it disables periodic
  durable writes) and a fixture passes it, so `||` anywhere on that path would silently promote
  an explicit "never" to the 30 s default. Pinned by its own test.

### Corrections to this ticket's own analysis

Three, all found by implementing it:

1. **The declared-surface ceiling needed no bump.** §2.3 predicted one. It was wrong:
   `envOverride` enters READS, not declarations, so the TS surface stayed at 142 against the
   `<= 155` ceiling. No test was touched for it.
2. **`durableSnapshotMs` and `statsTtlSec` are consulted per flush**, not at session start as
   §2.2(b) implied — only `heartbeatMs` is bound per SSE subscription. Its descriptor documents
   that narrower granularity rather than claiming per-flush.
3. **OD-3's 4-keep/3-retire split became 5-keep/2-retire** — see §4.

### A self-inflicted diff, reverted before commit

Running `prettier --write` over the touched files to clear three `prettier/prettier`
warnings I had introduced also reformatted **pre-existing** code — most destructively
`scripts/env-sync.mts`, which is written with 4-space indentation and long single-line
descriptors: prettier reindented the whole file, turning a ~70-line change into 657 lines
of noise.

The gate scoping settles which style is correct, and it differs by directory:

| Tree | Prettier enforced? | Resolution |
|---|---|---|
| `packages/applications/**` | YES — `prettier/prettier` runs as an ESLint rule under `pnpm lint` | keep prettier's formatting; leaving my own 3 warnings would fail the "no new lint errors" gate |
| `scripts/**` | NO — no `eslint.config.*`, no `package.json` (so outside `turbo run lint`), and every `*:format:check` script targets `apps/*` / `packages/*` only | restore the file's own 4-space style |

So `scripts/env-sync.mts` and `scripts/__tests__/env-sync.test.ts` were restored from the
Lane 1 commit and the Lane 3 test correction re-applied by hand in the file's own idiom.
Verified whitespace-only before reverting (`git diff -w` showed the churn was entirely
re-wrapping, no semantic change), and re-verified green afterwards. `_karpathy.md` §3:
"Match existing style, even if you'd do it differently" — and `pnpm format` writing
`**/*.ts` is not the same thing as a gate requiring it.

### Cache-key outcome (measured, vs. §2.3's estimate of ~505)

| Step | Entries |
|---|---|
| Baseline | 486 |
| Lane 1 (+21 detected reads) | 507 |
| Lane 2 (−2 dead) | 505 |
| Lane 3 (−2 retired) | **503** |

A CI cache cold-start on the first pipeline after merge is expected and is the point: until now,
changing `LIVE_DOC_HEARTBEAT_MS` invalidated nothing.

### Files changed

| File | Change |
|---|---|
| `scripts/env-sync.mts` | two reader lists + two scanner shapes; `envOverride` folded into `computeGlobalEnv()` |
| `scripts/__tests__/env-sync.test.ts` | 12 new tests across two describes |
| `packages/applications/.../registry.types.ts` | `SettingDescriptor.envOverride` |
| `.../descriptors/agentic-context.descriptors.ts` | 6 `envOverride` declarations |
| `.../descriptors/consultation-realtime.descriptors.ts` | 7 new keys + defaults + descriptors + `CONSULTATION_REALTIME_KEYS` |
| `.../descriptors/feature-availability.descriptors.ts` | `envOverride` on the groundedness gate, forwarded through `FeatureSpec` |
| `.../live-documentation/live-documentation.service.ts` | 9 constructor reads removed; `RealtimeBudgets` + `resolveRealtimeBudgets`; 11 consumers repointed |
| `.../__tests__/live-documentation.dead-provider-env.task940.test.ts` | new (3 tests) |
| `.../__tests__/live-documentation.realtime-budgets.task940.test.ts` | new (8 tests) |
| `turbo.json`, `env-surface.generated.md` | generated |
| `docs/operations/deprecation-register.md` | new §"Environment variables (TASK-940)" |

### Verification (actual output)

```
$ pnpm env:sync:check
env:sync --check OK — 12 artifacts match their declarations
  (142 TS keys + 308 Python fields · 503 globalEnv entries);
  no unread keys in 7 operator-facing files.

$ npx vitest run scripts/__tests__/env-sync.test.ts
Test Files  1 passed (1)      Tests  51 passed (51)

$ npx vitest run packages/applications/src/services/consultation/live-documentation/
Test Files  52 passed (52)    Tests  540 passed (540)

$ pnpm --filter @arcaai/applications build
(tsc, no output)

$ pnpm --filter @arcaai/applications test
Test Files  1 failed | 752 passed | 1 skipped (754)
Tests  12673 passed | 6 skipped (12679)

$ pnpm typecheck:all
Tasks:    44 successful, 44 total
(+ mypy: text 81, nlp 64, guardrail 45, harness 150, tts 42 — no issues)

$ pnpm --filter @arcaai/applications lint
✖ 182 problems (0 errors, 182 warnings)      # baseline 187; none in a TASK-940 file
```

**The one failing file is out of scope and is infra, not this change.**
`agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` fails in its
own `beforeAll` fixture — `PrismaClientKnownRequestError` on `unscoped.tenant.upsert` and
`unscoped.department.deleteMany` against the **test** database, which is not running (only the dev
compose stack is up; the isolated test infra on ports 5433/6380 is down). Its two actual tests
report **skipped**, and it exercises `runInTenantContext` over `Tenant`/`Department` — no Prisma
model, table or service this ticket touched. The root `vitest.config.ts` excludes
`**/integration/**`; the package's own `test:unit` does not, which is why it appears here and not
in the scoped runs above.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-10 | **Completed.** Lanes 1-4 landed; globalEnv 486 → 503. Three corrections to this ticket's own analysis (no ceiling bump needed; `durableSnapshotMs`/`statsTtlSec` are per-flush not session-start; OD-3 became 5-keep/2-retire on fixture evidence). Full gate output in §5. |
| 2026-09-10 | Base moved `cbbe5c257` → `8320ea15c`: the TASK-939 R7 `minIntervalMs` migration landed mid-survey, clearing the collision on `live-documentation.service.ts` and putting the cited precedent in `HEAD`. §2.4 and OD-1 revised. |
| 2026-09-10 | Ticket opened. Generator hypothesis confirmed and found to be two mechanisms, not one (§2.1); blast radius measured at 21 undeclared reads across 3 subsystems (§2.1a); all 18 live-doc names classified (§2.2); 2 found dead against a stated rule (§2.2(d)); cache-key cost quantified (§2.3); plan + 5 owner decisions. No code changed. |
| 2026-09-10 | OD-4's deferred half filed as **TASK-870 owner item 12** (the two `TENANT_IDP_*_ENABLED` switches), including a correction: they are per-tenant feature gates, not the `redis-flag` kill-switches I first called them. `HARNESS_BASE_URL` needs no follow-up — it is correctly `env`-tier topology and this ticket's declaration was the whole fix. |

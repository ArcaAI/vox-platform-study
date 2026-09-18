# D5 — Clinical vocabulary & Malayalam (TASK-985 area dossier)

Area author D5. Design only; no code, no tracked file touched, no live run.
Branch `agent/agent-transcription-coordination-9dbc25` = `dev-2.2` @ `3f9145a98`.
Scope: M-31, M-32, M-35, M-57; QW-7, ST-7, BP-4b arm (3); OD-E, OD-H (Malayalam half);
§2.5 error classes 4, 5, 6 and the §2.3 `Atorvacetam` datum.

Every distance below was computed by hand from `apps/stt/src/stt/postprocessing/lexicon.py`
as committed. Where a number would need a run, it is a **measurement request** in §6, not a claim.

---

## 0. The one-paragraph version

The corrector's two gates are the wrong two axes. It asks "does this sound like a drug name?"
and "is it spelled close to one?" — and both questions are answered YES by ordinary English
words (`creating`, `certain`, `isopropyl`) and NO by the actual mishearing the clinician
produced (`Atorvacetam`). The axis that separates them is the one the module does not have:
**is the candidate a word of the language at all?** Once that gate exists, the grapheme bound
should be *relaxed*, not tightened — which reverses QW-7's prescription. Everything else in
this area (the tenant dictionary, the Malayalam alias path, the batch/streaming language
split, the `hotwordsInPrompt` tier) follows from that one correction, plus one hard fact:
**the hotword channel is capped at 64 terms at both tiers** (`agent-schemas.ts:751`,
`asr-model-profile.ts:124`), so ST-7's dictionary cannot live on it and must be a new entity.

---

## 1. M-31 — lexicon precision

### 1.1 The five false rewrites, arithmetically

The matcher is two gates (`lexicon.py:22-54`): a phonetic gate over a Metaphone-class
consonant skeleton (`phonetic_keys`, `:124-253`) and a grapheme gate on normalised
Levenshtein. The grapheme ceiling is **0.34** (`DEFAULT_MAX_DISTANCE`, `:92`) when the keys
merely *agree* (Path B, `:536-559`), and **0.5** (`EXACT_KEY_GRAPHEME_CEILING`, `:95`) when
they are *equal* (Path A, `:519-534`). Cutoffs are integer-truncated:
`cutoff = int(bound * longest)` (`:527`, `:546`), so the effective ratio is coarser than the
declared one.

Recomputed against the served 20-term row list (`seed/ai-models/audio.ts:141`):

| Candidate | Term | Keys | Path | lev | longest | cutoff | verdict |
|---|---|---|---|---|---|---|---|
| `creating` | `creatinine` | `KRTNJ`/`KRTNK` vs `KRTN` (agree, 1/5) | B | 3 | 10 | `int(.34*10)=3` | **rewritten**, score 0.30 |
| `creative` | `creatinine` | `KRTF` vs `KRTN` (agree, 1/4) | B | 3 | 10 | 3 | **rewritten**, 0.30 |
| `creation` | `creatinine` | `KRXN` vs `KRTN` (agree, 1/4) | B | 3 | 10 | 3 | **rewritten**, 0.30 |
| `isopropyl` | `bisoprolol` | `ASPRPL` vs `PSPRL` (agree, 2/6) | B | 3 | 10 | 3 | **rewritten**, 0.30 |
| `certain` | `creatinine` | secondary `KRTN` **equals** term key | A | 5 | 10 | `int(.5*10)=5` | **rewritten**, 0.50 |
| `septrioxone` | `ceftriaxone` | `SPTRKSN` vs `SFTRKSN` (agree, 1/7) | B | 3 | 11 | 3 | correct (designed) |
| `sephotrioxone` | `ceftriaxone` | keys **equal** | A | 5 | 13 | 6 | correct (designed) |
| `Atorvacetam` | `atorvastatin` | `ATRFSTM`/`ATRFKTM` vs `ATRFSTN` (agree, 1/7) | B | **5** | 12 | `int(.34*12)=4` | **MISSED** |

Two structural observations the README does not state:

1. **Four of the five false rewrites land at exactly score 0.30 on a 10-character term.**
   That is not a coincidence: `int(0.34 * 10) = 3` hands every 10-char term a three-edit
   budget, and three edits is enough to turn a common English participle into a drug name.
   Long terms buy large absolute budgets; the normalised bound hides that.
2. **`certain` is the only one that needs the relaxed ceiling**, and it gets there through
   the *secondary* key. `phonetic_keys` emits `("S","K")` for `C` before a front vowel
   (`:172-174`), so `certain` carries `KRTN` as its alternate — identical to `creatinine`'s
   sole key. The secondary key exists to rescue `ceftriaxone`; it also hands `certain` a
   0.5 ceiling.

Incidental defect found while recomputing (D5-N4 below): `following` is `""` at the last
letter (`:158`), and `"" in "EIY"` is `True` in Python (substring test, not set membership).
So a **word-final `C` or `G` takes the front-vowel branch** — `creating` keys as `KRTNJ`,
not `KRTNK`; `tonic` keys `...S`, not `...K`. The `_VOWELS` checks are unaffected because
`_VOWELS` is a `frozenset` (`:107`), where `"" in` is `False`. This is invisible on the two
designed cases and silently wrong everywhere else.

### 1.2 Can one bound fix both directions? No — provably.

Solve for the bound that keeps each case:

| Case | Requirement on the bound |
|---|---|
| keep `septrioxone -> ceftriaxone` (Path B) | `int(b*11) >= 3` ⇒ `b >= 0.2727` |
| keep `sephotrioxone -> ceftriaxone` (Path A) | `int(r*13) >= 5` ⇒ `r >= 0.3847` |
| drop `creating/creative/creation` (Path B) | `int(b*10) < 3` ⇒ `b < 0.30` |
| drop `isopropyl` (Path B) | `b < 0.30` |
| drop `certain` (Path A) | `int(r*10) < 5` ⇒ `r < 0.50` |
| **keep `Atorvacetam -> atorvastatin` (Path B)** | `int(b*12) >= 5` ⇒ **`b >= 0.4167`** |

`b >= 0.4167` and `b < 0.30` are unsatisfiable. **No single strict bound admits the real
mishearing and rejects the ordinary words.** The bound is not the lever.

There *is* a bound pair that fixes the five false rewrites while keeping the two designed
true positives: **strict 0.28, relaxed 0.40**. It is a two-point-wide band curve-fitted to
five observed cases with no margin, and it leaves `Atorvacetam` missed. Ship it only as a
stop-gap with that limitation written beside it.

### 1.3 Why `Atorvacetam` was missed at the same time ordinary words were rewritten

It failed the **grapheme** gate while passing the **phonetic** one — the exact mirror of
`sephotrioxone`, which fails grapheme (0.385) and is rescued by key *equality* unlocking the
0.5 ceiling (`:519-534`). `Atorvacetam`'s key is `ATRFSTM`; `atorvastatin`'s is `ATRFSTN`.
They differ by one terminal consonant, `M` vs `N` — two nasals, the single most confusable
consonant pair in speech, and a difference the compact key deliberately preserves because it
never collapses `M` and `N` (`:248`, both pass through `"FJLMNR"` verbatim). One edit is
enough to lose *all* relaxation, because the relaxation is a **binary switch on exact key
equality**, not a function of how close the keys are. So the candidate falls to the strict
0.34 path, where its grapheme distance is 5/12 = 0.4167, and `int(0.34*12) = 4` rejects it by
one edit. Meanwhile `creating` — whose keys are *also* one edit apart — sails through the same
strict path because its term is two characters shorter, giving `int(0.34*10) = 3` against a
distance of exactly 3.

**The matcher itself must change.** The design below replaces the binary relaxation with a
graded one and adds the axis that actually separates the two directions.

### 1.4 The fix

**(a) The missing axis: a protected-vocabulary gate.**

`creating`, `creative`, `creation`, `certain`, `isopropyl` and `oxygen` are all **words of the
language**. `septrioxone`, `sephotrioxone`, `Atorvacetam` are **not words at all**. That is
the only feature that separates the two sets, and neither current gate can see it. Rule:

> A window whose every token is a known ordinary word of the hypothesis's language is
> **never** rewritten, at any distance, on any path.

This is a hard refusal, not a score penalty. Rationale: a spurious drug or lab name inserted
into a clinical record is a patient-safety event; a missed correction is a legible
mis-spelling the clinician can read past. The stage fails safe by refusing.

Consequences worth stating:
- `oxygen -> oxycodone` (the module's own worked example, `:46`) becomes doubly protected —
  by the word gate *and* by the grapheme bound. The docstring's table should say so.
- Once the word gate exists, the bound is free to **relax**, not tighten. At strict 0.42 /
  relaxed 0.45, `Atorvacetam -> atorvastatin` (0.4167) is admitted, `septrioxone` and
  `sephotrioxone` keep working, and the five false rewrites are stopped by the word gate
  rather than by arithmetic. **This is the opposite direction from QW-7's "tighter grapheme
  bound"**, and it is the direction that fixes both findings at once. The exact relaxed
  values are a measurement (§6 MR-1), not a claim.

**(b) The graded relaxation** (replaces the binary exact-key switch, `:357`,
`:519-534`): let `k` be the normalised key distance. Ceiling `= strict + (relaxed - strict) *
(1 - k / strict)`, clamped to `[strict, relaxed]`. Equal keys (`k = 0`) still earn the full
relaxed ceiling, so `sephotrioxone` is unchanged; `Atorvacetam` (`k = 1/7 = 0.143`) earns
roughly two-thirds of the relaxation instead of none. `certain` (`k = 0`) earns the full
relaxation and is stopped by the word gate, which is where it belongs.

**(c) Exact-key-first ordering stays.** Path A's dict lookup (`:522`) is the cost design and
must survive. The change is what the two paths *earn*, not how they are found.

**(d) Fix the word-final `C`/`G` branch** (D5-N4): compare `following` against a set, or guard
`following and following in "EIY"`. Regenerate any stored key fixtures in the same change.

### 1.5 Where the stop-list lives — tier, scope, governance

It is **data, not a code literal and not an env var** (`09-infrastructure-devops.md`
§Configuration Tiers: env is the bootstrap floor only). But it is also not tenant
configuration: every tenant wants `creating` protected, and no tenant authors an English
word list. Naming it honestly matters, because the wrong tier makes it either unmaintainable
or a 25 000-row-per-tenant clone.

**Two parts, two tiers:**

| Part | What | Tier | Why |
|---|---|---|---|
| **Platform protected vocabulary** | A versioned, digest-addressed word list per language (`en`, later `ml`), surface forms including inflections. Sized for the job: the top ~20–30k frequent English words plus frequent clinical English that is not a drug name — ~200–300 KB, not a 210k full dictionary. | **Artifact, addressed by a governed pointer** — the bytes live in the `hope-models` MinIO bucket and are staged exactly like model weights (TASK-960 bucket-staged rows, `bucketPrefix` bucket-relative); the pointer is a `db-config` field on the ASR row, `AiModel._metadata.asr.protectedVocabularyRef = { slug, version, sha256 }`. | Same lifecycle and same delivery path as the weights it protects. It is a *language* property, so it is neither `global-kv` (a 300 KB `GlobalSetting` value is tier abuse) nor per-tenant. The digest joins the BP-1 fingerprint, so a list change is a visible baseline change. |
| **Tenant protected-term delta** | Two short lists on the tenant's clinical dictionary (§2): `protect` (words this tenant never wants rewritten) and `unprotect` (words the platform list protects that this tenant genuinely uses as a clinical term — a formulary brand called "Certain"). Tens of entries, not thousands. | **Tenant CONTENT**, on the dictionary entity of §2 — cloned from the SYSTEM reference set at tenant creation, tenant-owned thereafter, never read cross-tenant at runtime. | It is authored by a tenant admin and it is institution-specific. `00-project-context.md` §"Content is cloned; configuration cascades" puts authored, admin-edited, reference-set-seeded material in the content lane. |

Resolution at runtime is therefore **not** a tenant→SYSTEM cascade and must not be described
as one: the platform list is a *shared asset* the runtime loads once per process (frozen set,
beside the `ModelCache`), and the tenant delta is applied *over* it as a set difference/union
computed at spec-resolution time in the gateway. `apps/stt` reads no Postgres on the agent
path (TASK-861), so the delta rides `ResolvedAsrSpec` and the asset rides the bucket.

Scoping and cache keys: the merged protected set is cached in STT keyed by
`(tenantId, assetSha256, deltaSha256)` — `tenantId` is mandatory in any config cache key
(§Config caches rule 1). Invalidation on dictionary publish via the existing
`app-settings`-style channel; TTL is the backstop, not the mechanism.

### 1.6 Log and counter

`inference.py:325-335` logs each correction at **DEBUG** with `original` and `replacement`.
QW-7 says "INFO log + counter". Promoting that line as written is a **PHI regression**, and
the file says so itself: `_report_script_mismatch` (`inference.py:352-360`) deliberately
carries no text because "the log is the only place a transcript can be read without
decrypting a `ContextItem`". `replacement` is safe (it is configured vocabulary the tenant
authored). `original` is decoder output over patient speech and is not.

Design:

```
INFO  stt.postprocessing.lexicon.correction
      session_id, utterance_index, is_final,
      term=<replacement — configured vocabulary, safe>,
      stage=<exact|phonetic|graded|alias|space_agnostic>,
      score=<float>, original_len=<int>, protected_hit=<bool>
DEBUG stt.postprocessing.lexicon.correction.detail   # unchanged, keeps `original`
```

Counters (PHI-safe metric shape per §2.6 — bounded labels, **no tenant label**):

| Metric | Labels | Why |
|---|---|---|
| `stt_lexicon_corrections_total` | `stage`, `is_final` | the numerator |
| `stt_lexicon_tokens_scanned_total` | `is_final` | M-45's lesson: a counter with no denominator cannot tell 25 % from 0.5 % |
| `stt_lexicon_rejected_total` | `reason` ∈ {`protected_word`, `grapheme`, `phonetic`, `min_chars`, `punctuation`, `already_term`} | makes the stop-list's effect *visible in production*, which is the only way the word gate's completeness is ever measured after ship |
| `stt_lexicon_latency_seconds` | `is_final` | ST-7's budget gate (§2) |

Also: `lexicon_correction_count` already reaches the teardown summary
(`session_manager.py:4230-4232`) but nothing exports it. Fold it into BP-5's
`session_summary` INFO line together with `rejected{protected_word}`.

---

## 2. ST-7 — clinical post-correction after commit

### 2.1 Why this cannot be the hotword list

`instruction.hotwords` is capped at **64 items** at *both* tiers
(`agent-schemas.ts:751` `maxItems: 64`; `asr-model-profile.ts:124`
`AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS = 64`), and the corrector caps at 256
(`lexicon.py:98`). F9-K2's dictionary is 1070 entries. The channel is an order of magnitude
too small, and widening it would put a 1000-term string into the decoder prompt for any row
with `hotwordsInPrompt` on — which is the 2 % collapse (`whisper_cpp_asr.py:404-412`). ST-7
needs a **new entity**. That is a fact about the caps, not a preference.

Two further reasons the two lists must stay distinct: hotwords are *decoder bias* (they must
be few, or they crowd a 224-token prompt window — M-09); dictionary entries are *post-hoc
recovery* (they may be many, and cost only CPU).

### 2.2 Data model

**Entity: `ClinicalLexicon` + `ClinicalLexiconVersion` + `ClinicalLexiconEntry`.**
Shape deliberately mirrors `PromptTemplate` / `PromptVersion`, which is the repo's existing
authored-content-with-versions pattern.

```
ClinicalLexicon          tenantId, slug, name, language ('ml-en'), status, tags,
                         source*  (provenance columns, per the reference-set contract)
ClinicalLexiconVersion   lexiconId, versionNumber, status (DRAFT|PUBLISHED|DEPRECATED),
                         contentSha256, entryCount, publishedAt/By
ClinicalLexiconEntry     versionId, canonical (the text that publishes),
                         aliases[]      (exact-match strings, BOTH scripts),
                         category       (DRUG|LAB|DIAGNOSIS|ABBREVIATION|PROCEDURE|OTHER),
                         matchPolicy    (EXACT_ONLY | FUZZY),
                         minScore?      (per-entry override of the bound)
                         + the two protected-word deltas at version level:
                         protect[], unprotect[]
```

**Five bullets, as the return contract asks:**

- **Entity** — `ClinicalLexicon` (+ `Version`, + `Entry`), a new tenant-scoped model; add to
  `TENANT_SCOPED_MODELS`, add `ResourceType` members in **both** `audit.prisma` and
  `packages/domains/src/enums/generated/ResourceType.ts` (the TASK-366 failure mode), and
  hand-author the entity/factory/mapper/repository (`gen:mapper` is destructive).
- **Tier** — **CONTENT, not configuration.** Authored by a tenant admin, versioned, seeded
  from the SYSTEM reference set at tenant creation and re-syncable via
  `POST /admin/tenants/:id/reference-set/sync`, then tenant-owned with `source*` provenance.
- **Cascade** — **there is none, and that is the point.** Content is *cloned*, not cascaded
  (`00-project-context.md` §"Content is cloned; configuration cascades", TASK-890 OD-M).
  `SYSTEM_SHARED_READ_MODELS` is **not** widened. A tenant with no dictionary gets the empty
  set and the stage is a no-op — never another tenant's, never SYSTEM's, at runtime. A
  tenant's dictionary can name a locally-used brand or a department's jargon and is therefore
  institution-identifying; a runtime read across the boundary would be exactly the leak the
  rule exists to prevent.
- **Admin surface** — `/ai-services` (or the STT domain screen) gains a lexicon tab:
  `AdminDataGrid` of entries with inline edit, CSV import/export (a formulary arrives as a
  spreadsheet), a draft→publish flow with `If-Match`/ETag OCC like every other versioned
  item, and a **dry-run panel** that pastes a transcript and shows what would change before
  publish. Routes `admin/clinical-lexicons/*`, ability-gated `manage:ClinicalLexicon`;
  the SYSTEM reference row is super-admin-only on the SYSTEM-vs-tenant-owned split-gate
  pattern (`05-nestjs-api.md`), existence resolved before privilege.
- **Delivery to the runtime** — `ResolvedAsrSpec.postProcessing.lexicon` gains
  `dictionaryRef: { id, version, sha256, entryCount }` (NOT the entries). STT fetches
  `GET /internal/stt/clinical-lexicons/{id}/{version}` once, caches by
  `(tenantId, sha256)`, and keeps Postgres off the agent path. The sha256 joins the BP-1
  fingerprint, so a dictionary edit is a visible baseline change rather than an invisible
  one. A fetch failure is **fail-open**: publish uncorrected (a correction stage is an
  enhancement, never a gate — `lexicon.py:96`).

Note the README's ST-7 row says "dictionary is tenant content **cascaded** per the rules".
That phrase is self-contradictory under the owner rule and is listed as a new defect (D5-N1).

### 2.3 Pipeline position and latency budget

**Position: exactly where `_apply_lexicon` sits today for FINALS — `inference.py:617`, after
punctuation and disfluency, before lowercase — synchronous, before publish. Not after
publish, no republish.**

- *Not on partials.* The partial path (`inference.py:1335`) keeps the cheap bounded
  hotword corrector (≤ 64 terms, microseconds) so the live caption still snaps drug names.
  The staged matcher against ~1000 entries is one to two orders of magnitude more work and
  the partial path is already decode-bound at a 300 ms cadence on a shared per-model lock
  (`whisper_cpp_asr.py:429`).
- *Not a republish.* Punctuation may republish (M-41's gloss shape) because a comma appearing
  late is cosmetic. A **drug name** appearing or changing after a clinician has read the line
  is semantically load-bearing and is the kind of silent edit a clinical record must not make.
  The persisted transcript is written from the published final, so a republish also opens a
  second write path to reconcile.
- *Ordering rider.* `self._previous_text` (the decoder carry-forward) is taken at
  `inference.py:583-590`, **before** punctuation and the lexicon, so a correction never rides
  the next window's prompt. **Keep it that way by default.** The repo's own measured lesson is
  that carry-forward amplifies errors until they sustain themselves (the script-mismatch
  clearing at `:583-590` exists for exactly that). Correcting the carry-forward is a
  *measurable arm* (§6 MR-5), not a default.

**Budget.** p95 ≤ 25 ms per final; hard time-box 60 ms. Justification: the final path already
spends ~350 ms decode (cluster p50) plus up to 400 ms cadence-fast punctuation
(`inference.py:1250`), so 25 ms is ~3 % and cannot move commit p50. Gate: commit p50 must not
rise by more than 50 ms in the ST-7 arm. On timeout, fall back to the **bounded hotword
corrector's** result — not to raw text — so a slow dictionary never *loses* the corrections
the cheap stage already makes.

### 2.4 The staged matcher

Five stages, each with its own admission rule, tried in order; first hit wins; every stage
subject to the safety rules of §2.5.

| # | Stage | Rule | What it recovers |
|---|---|---|---|
| 1 | **exact** | folded window == `canonical` or any `alias` | zero-risk; also the **abbreviation/transliteration path** (class 5) |
| 2 | **space-agnostic** | concatenation of a 2–4 token window matches an entry exactly, or within `strict` | `cef tri axone`, `വി പി ഡി` -> `BP` |
| 3 | **substring/affix** | entry is a prefix or suffix of the window, or vice versa, with the residue ≤ 2 chars | `atorvastatin-` fragments, class-3 orphan fragments |
| 4 | **phonetic + graded grapheme** | §1.4(b), non-words only | `septrioxone`, `Atorvacetam` |
| 5 | **n-gram / character-trigram** | Jaccard over char trigrams ≥ 0.65 **and** phonetic agreement, non-words only | long polysyllabic names the edit bound misses |

`MIN_TOKEN_CHARS = 4` (`lexicon.py:101`) blocks every 2–3 letter abbreviation (`BP`, `CBC`,
`LFT`) from ever being corrected today. Stages 1 and 2 must **bypass** it — but *only* on
exact match, where there is no distance to be wrong about.

### 2.5 Safety rules — what keeps it from inventing clinical content

1. **Closed vocabulary.** The output string is always an entry's `canonical`. The stage
   cannot emit a token that is not in the tenant's dictionary. (Already true of the hotword
   corrector; must survive.)
2. **No insertion, no deletion.** Tokens may be *merged* by stage 2 when the concatenation
   matches; they are **never split**, and no token is ever added or dropped.
3. **Never rewrite an ordinary word** (§1.4(a)), unless the tenant's `unprotect` list names it.
4. **Never cross punctuation or a clause boundary** (`_window_text`, `lexicon.py:626-643`).
5. **Never rewrite across scripts by distance.** A Malayalam token becomes a Latin term only
   through an **authored alias** (stage 1/2). A distance metric never licenses a cross-script
   rewrite. This is the single most important rule for a Malayalam-English platform.
6. **Idempotence.** `correct(correct(x)) == correct(x)`, guaranteed today by the
   `self._configured` guard (`lexicon.py:497`); pin it with a property test.
7. **Bounded blast radius, new.** If more than a threshold share of a final's tokens are
   corrected (start at 30 %, or > 5 corrections in one final), publish the **uncorrected**
   text and emit `WARN stt.postprocessing.lexicon.blast_radius`. A final where a third of the
   words snapped to drug names is a matcher failure, not lucky recall.
8. **Provenance, new.** The `Correction` list travels with the final onto `SegmentResult` and
   into the durable transcript record, so a clinician (or an auditor) can see that a term was
   machine-corrected and what it replaced. Without this, ST-7 makes silent edits to a medical
   record.
9. **Dose safety, new.** A correction whose window is adjacent to a numeric token is held to
   stage 1/2 only (exact or space-agnostic). Fuzzy-matching next to a number is where a unit
   or a strength gets rewritten.

### 2.6 F9-K2 — what transfers to Malayalam-English and what does not

F9-K2 (JMIR/PMC 2026, PMC13344086): **Dictionary-Augmented *LLM* Postprocessing** for
bilingual code-switched medical ASR; **CER 0.234 -> 0.082, a 64.9 % reduction**, with a
**1070-entry dictionary**, in a **Korean-English** setting.

**Transfers:**
- The *scale* finding. ~1000 curated entries is enough; a full formulary is not needed. That
  is the number the `ClinicalLexiconEntry` design is sized for, and it is 16x the 64-item
  hotword ceiling — which is the quantitative case for a new entity.
- The *premise*. Code-switched clinical ASR has a dominant, **enumerable** error vocabulary.
  §2.5's own classes 5 and 6 (~22 of ~55 English items corrupted, 4/4 abbreviations) say the
  same thing about the owner's corpus.
- The *evaluation shape*. CER primary for a non-Latin script (also F9-E2), with the
  dictionary version pinned in the run record.

**Does NOT transfer — state this plainly before anyone quotes 64.9 %:**
- **The method.** Their corrector is an **LLM** given the dictionary in context. ST-7 as
  written in the README is a deterministic string matcher. **The 64.9 % is not attributable
  to string matching**, and the README row cites it as if it were. A string matcher will
  recover classes 5 (aliases/abbreviations) and part of 1/3; it will recover **none** of
  class 6 (LM-prior substitution: vomiting -> jaggery, cough -> Tuesday). `ശർക്കര` and `ഛർദി`
  are not close under any string or phonetic metric; only context can tell them apart.
- **The language pair.** Korean medical vocabulary is heavily English-loan written in Hangul,
  an alphabetic syllabary with a mature standard romanization — so a Korean-English clinical
  dictionary is largely a *transliteration table*, which is precisely the part that maps onto
  stages 1–2 here. Malayalam is an abugida with conjuncts, chillu letters and ZWJ/ZWNJ
  variants, with no comparable clinical romanization convention, and F9-M1 records Whisper
  emitting Malayalam in **Tamil** script. Normalisation alone is a larger problem than in
  Korean.
- **The setting.** Theirs is offline post-hoc. Ours is a live loop with a commit deadline; an
  LLM hop would have to go to `apps/text` (the "do not grow a second inference stack" rule),
  adding a gateway->text round trip to the STT final path, plus a guardrail/PHI review of
  sending transcript text to a second service.

**Honest position:** ST-7's deterministic matcher is the right *first* step — it is bounded,
auditable, sub-25 ms and cannot invent content. An LLM corrector is the thing F9-K2 actually
measured and belongs as a **separate, later, owner-decided item** (a `CLINICAL_CORRECTION`
agent on the existing `apps/text` plane, finals-only, off the live path, applied to the
durable transcript rather than the caption). Do not attribute the deterministic stage's
expected gain to F9-K2's number.

---

## 3. Malayalam-specific classes 4/5/6 — does ITN belong here?

### 3.1 Class 4 is not an ITN problem

§2.5 class 4: the article `ഒരു` emitted as the digit `1` (16/16 cases), and doubled numerals
`1212`, `110 110`. There is no ITN stage anywhere in `apps/stt` — `postprocessing/` holds
exactly `disfluency.py`, `lexicon.py`, `overlap.py`, and a repo-wide grep for
inverse-text-normalisation, denormalisation or number-normalisation finds nothing in
`apps/stt` or `apps/nlp`. The README's "points at model normalization (no ITN stage exists)"
is correct as an observation. The inference drawn from it is not.

**ITN converts spoken form to written form** ("one hundred ten" -> "110"). Class 4 asks for
the **opposite** in one half (`1` -> `ഒരു`, a digit back to a word) and for **de-duplication**
in the other (`110 110`). Calling it ITN is a category error, and building an ITN engine
would address neither half.

**Recommendation: no, an ITN/denormalisation stage does not belong in `apps/stt`.** Three
reasons, in order of weight:

1. **It is a number rewrite on the PHI path.** In a clinical record a number is a dose, a
   strength, a BP, an INR. A rule engine that silently rewrites numbers is the single most
   dangerous post-processing stage one could add, and it would need a far higher bar than a
   closed-vocabulary word snap — which is the same reasoning that declined a general lexicon
   (TASK-935 OD-2 (b)).
2. **It is a per-language grammar asset with its own governance.** A Malayalam ITN (WFST or
   rule set) plus a code-switched Malayalam-English variant is a data product, not a
   post-processing function. It would need the same artifact tier, versioning and digest
   discipline as §1.5's protected vocabulary, for far less benefit.
3. **The consumer that needs canonical numbers is downstream, and already handles both
   forms.** The clinical note is written by an LLM in `apps/text` from the transcript; it
   reads `1` and `ഒരു` equally. The live caption is the only surface that shows the raw form,
   and there the honest fix is at the source.

### 3.2 What to do instead

- **(a) Measure before building.** The corpus is predecessor-stack, pinned `ml-IN`, 2025-08-12
  (§2.5 preamble). The served path is unpinned `ml-en` with a pair prompt. Class 4 may not
  reproduce at all. Counters `article_digit_rate` and `number_form_agreement` on the BP-4
  replay decide it (§6 MR-6).
- **(b) If it reproduces, the cause is the fine-tune's training normalisation**, which makes
  it an input to **OD-I** (re-fine-tune with the inference-time format) and to **OD-B**, not a
  post-processing ticket. A model that was trained on digit-normalised Malayalam will keep
  emitting digits whatever runs after it.
- **(c) The doubled numerals belong to QW-10**, not here — with one rider that is specific to
  this area: the seam de-dup should treat an **adjacent repeated numeric token** as a
  de-dup candidate even when the surrounding words differ (`110 110` is the most legible
  instance of class 1), and a final containing an adjacently repeated numeric token should
  emit a WARN, because a doubled dose is a patient-safety event and should never be silent.
- **(d) Do NOT special-case `1` -> `ഒരു`.** Whether the digit is the article or a genuine
  quantity is exactly the context judgement a rule cannot make, and getting it wrong inserts
  or deletes a quantity. Leave the digit, put `article_digit_rate` on the dashboard so its
  cost is visible, and let the note prompt handle it.
- **(e) If the owner overrules (a)–(d):** the stage goes in `apps/stt/postprocessing/` after
  the lexicon, as a governed `postProcessing.numberFormat` block on the agent schema, with
  the grammar as a bucket-staged per-language asset delivered exactly like §1.5's protected
  vocabulary, **finals only, fail-open**, and with a hard exclusion for any window adjacent to
  a unit token (mg, ml, mmHg, units, `%`). Costed here so the option exists; not recommended.

### 3.3 Classes 5 and 6

- **Class 5 (English terms and abbreviations transliterated: `വി പി ഡി`, 4/4 of BP/CBC/LFT
  lost)** is the highest-yield, lowest-risk target in this whole area and needs **no fuzzy
  matching at all**. It is an authored alias: `ബി പി` -> `BP`, exact match, space-agnostic,
  `MIN_TOKEN_CHARS` bypassed. Stages 1–2 of §2.4 plus `ClinicalLexiconEntry.aliases[]` is the
  entire fix. It also needs the keyterm fixtures to carry both scripts — today
  `apps/stt/tests/e2e/fixtures/clinical/*.keyterms.json` are Latin-only with no synonym map
  and no abbreviations, so `abbrev_recall` cannot be measured at all yet (D5-N5).
- **Class 6 (LM-prior substitution)** is out of reach of any string matcher (§2.6). Its
  honest owners are the prompt/LM side (OD-B, OD-I) and, later, an LLM corrector. Do not
  promise it to ST-7.

### 3.4 OD-H, the Malayalam half

OD-H asks for the Malayalam *fallback engine*. From this area's angle, one constraint the
row does not state: **the lexicon stage is engine-independent but its vocabulary is not
carried across a switch.** M-34 records that the engine switch swaps only the callable and
leaves prompt, language, window and lexicon at the primary's; ST-6 fixes that. Riders from
here:

- A quantized sibling of the same fine-tune (the recommended answer) inherits the same
  mishearings, so the dictionary transfers unchanged — this is the *cheapest* option for
  this area and is another argument for it.
- An **IndicConformer-ml** lane (F9-M3) has a different error vocabulary entirely; its
  dictionary entries would have to be re-derived, and the platform protected-vocabulary
  asset would need a Malayalam list it does not have. Cost this into OD-H.
- A **cloud** fallback (Sarvam / Azure ml-IN) mostly supplies its own biasing (Azure phrase
  lists, F9-K3) and would need the dictionary pushed through the vendor's own channel
  (ST-6's "native biasing per engine"), not through this stage. Plus the residency/PHI-egress
  decision OD-H already names.

---

## 4. M-32 — batch vs streaming language policy

### 4.1 Mechanism, confirmed

| Path | Call | Result for `ml-en` on whisper.cpp |
|---|---|---|
| **Streaming** | `session_manager.py:2253-2255` -> `resolve_mode_for_engine(mode_id, asr_model.format)` (`language_modes.py:413`) | capability `prompt` (`:449-471`): `language=None`, `code_switching=False`, `initial_prompt = build_code_switch_prompt('ml','en')` |
| **Batch / default** | `spec.py:703` -> `_language_from_mode(decoding)` (`spec.py:561-582`) | `return mode.primary_language, code_switching or mode.kind == 'code_switch'` (`:582`) ⇒ **`language='ml'`, `code_switching=True`**, no prompt |

So one agent has two language policies, and they differ in **three** ways, not one:
`language` (`None` vs `'ml'`), `code_switching` (`False` vs `True` — and for whisper.cpp
`code_switching` is meaningless, which `language_modes.py:469` knows and the batch reading
does not), and the **pair prompt** (present vs absent). English batch audio submitted to the
ml-en agent is decoded with a Malayalam language token and no code-switch priming.

### 4.2 Design

The obstacle `_language_from_mode`'s own docstring names — *"the engine-independent reading a
batch job, which has no session language-mode resolution, needs"* — is no longer real. The
batch path **has** the engine: `ResolvedAsrSpec.models.asr.format` travels on the spec and is
exactly what the streaming path reads at `session_manager.py:2255`.

1. Replace `_language_from_mode(decoding)` with `_language_for_engine(decoding, engine_format)`,
   a thin wrapper over `resolve_mode_for_engine`, called at `spec.py:703` with
   `models.asr.format`.
2. Preserve the fail-open posture exactly: unknown mode ⇒ `(None, code_switching)` + WARN, as
   today (`spec.py:571-580`). Add one case: `LanguageModeUnsupportedError` ⇒ `(None, False)`
   + WARN — an engine that cannot serve the mode must not be pinned to half of it.
3. **Carry `initial_prompt` through as well.** Otherwise batch and streaming still differ by a
   prompt, and BP-2's prompt arms — measured on the streaming path — do not transfer to the
   batch CER gate, which is the platform's only Malayalam number.
4. Compose, do not overwrite: the resolved prompt composes with the agent's
   `instruction.initialPrompt` the same way streaming does (`session_manager.py:2280`).
5. `codeSwitching` becomes derived, never stored twice — which also closes M-14's
   "`codeSwitching` overwritten" rider on the batch side.

**Recorded consequence:** this changes behaviour for every existing `ml-en` batch job. It is a
correctness fix, but it must be registered as a behaviour change and the `ml-en` batch CER
baseline re-captured under it (it is one of the entries BP-1 re-captures anyway).

**Tests:** a table test over all six `languageMode` values x every `AiModelFormat`, asserting
batch and streaming produce the **same** `(language, code_switching, initial_prompt)` triple;
and a regression case pinning `('ml-en', WHISPER_CPP) -> (None, False, <pair prompt>)` on both
paths. Live: MR-4 below.

---

## 5. M-35 / M-57 / OD-E — the governed write path and the empty list

### 5.1 M-35 — `hotwordsInPrompt` is unreachable from BOTH tiers, not just one

Stronger than the README states. The switch is *read* on two tiers and *writable* on neither.

| Tier | Read | Write | Evidence |
|---|---|---|---|
| Agent `parameters.decoding` | **yes** — `build-resolved-asr-spec.ts:328-332`, can stamp `sources.hotwordsInPrompt = 'agent'` | **no** — the `decoding` block is `additionalProperties: false` (`agent-schemas.ts:421`) and declares no `hotwordsInPrompt` key, so a draft carrying it fails publish validation | schema block `agent-schemas.ts:420-495` |
| Model row `_metadata.asr.decoding` | **yes** — parsed and allow-listed (`asr-model-profile.ts:185-189`) | **no** — `AsrProfileDecodingRequest` has no such field, and the global pipe is `whitelist + forbidNonWhitelisted`, so `PATCH admin/ai-models/:id` with it is a **400**, not a silent drop. `model-form-sheet.tsx:173` builds `decoding` from `asrHotwords` alone | `asr-profile.request.ts` (full class read); `05-nestjs-api.md` §Bootstrap Facts |

Grep confirms the key appears in **no seed row**, so it is `undefined` platform-wide and the
engine default (OFF) stands everywhere.

Two consequences the README does not draw:

- **BP-4b arm (3) is currently unrunnable** without a direct DB write. That moves M-35 out of
  Wave 2 and into the BP-1/BP-2 prerequisites: it is a *measurement blocker*, not a tidiness
  item.
- **A green unit test already asserts a precedence the schema forbids.**
  `build-resolved-asr-spec.test.ts:406` builds `withProfile({ decoding: { hotwordsInPrompt:
  true } }, { decoding: { hotwordsInPrompt: false } })` and asserts the agent wins. That is
  the two-tier drift surface OD-E warns about, already realised in CI (D5-N2).

### 5.2 Recommendation on OD-E: **ONE tier — the model row**

Four arguments, strongest first:

1. **It is a fact about the weights, not about the agent.** The measurement behind the switch
   is explicit at `whisper_cpp_asr.py:404-412`: on the seeded ml-en fine-tune, priming prompt
   + agent prompt + terms produced **2 % Latin**, versus 100 % with no terms. That is a
   property of those weights. A per-agent switch invites an admin to set it on an agent and
   then swap `modelId` underneath (the agent form permits exactly that), silently re-enabling
   the collapse on weights that were never measured with it.
2. **The sibling precedent is already one-tier and already works.** `initialPrompt` on the
   model row is documented as *"the priming prompt this fine-tune was measured with (OD-11) —
   a per-model property, not an agent-wide truth"* (`asr-profile.request.ts`). Putting the
   switch that modifies the prompt at a *different* tier from the prompt is the drift.
3. **The agent tier is already dead by construction**, so "two tiers" costs a schema change, a
   DTO field, a form control, a resolver branch and a precedence test — for a value with
   exactly one correct answer per row. It also gives `sources.hotwordsInPrompt` a second legal
   value that nothing can currently produce correctly.
4. **The split is coherent as one-for-the-switch, two-for-the-list.** *Which* vocabulary
   matters is a tenant/department choice and legitimately stays two-tier
   (`build-resolved-asr-spec.ts:412-426`). *Whether those terms may enter this model's prompt*
   is not a tenant judgement. Each tier then owns a fact it actually knows.

**Counter-argument, stated:** TASK-934 OD-4(a) set a general "agent -> model profile -> engine
default" precedence for decode knobs, and a one-off exception is something a later ticket will
"fix" back.
**Mitigation — make the exception mechanical, not documentary:** delete the agent read at
`build-resolved-asr-spec.ts:328-332` outright (so `sources.hotwordsInPrompt` can only ever be
`'model'`), delete the contradicting test at `:406`, and add a test asserting an agent-tier
value is **ignored**. A rule enforced by a removed code path cannot drift; a rule enforced by
a comment will.

**Then add the write path:** `hotwordsInPrompt?: boolean` on `AsrProfileDecodingRequest`, a
checkbox on `model-form-sheet.tsx` beside the hotwords field, with helper text naming the 2 %
measurement and the row it was measured on.

### 5.3 M-57 — explicitly-empty vs absent hotwords

Confirmed, and it is **two** sub-defects:

- **(i) The resolver destroys the information on its first line.**
  `build-resolved-asr-spec.ts:414`: `const agentHotwords = Array.isArray(i.hotwords) ?
  i.hotwords.filter(...) : []` — `undefined` and `[]` are already the same value before the
  precedence branch at `:425` (`if (agentHotwords.length > 0)`) ever runs. Downstream,
  `spec.py:754` computes `enabled = bool(lexicon_terms)`, so the model row's 20 terms and the
  lexicon stage run for a tenant that explicitly cleared the list.
- **(ii) The console cannot even produce `[]`.**
  `create-agent-wizard.tsx:90` writes `...(hotwords.length ? { hotwords } : {})` — clearing
  the field **omits the key**. `agent-detail.tsx:185` round-trips through the same shape. So
  the state M-57 describes is unreachable from the UI *today*, and becomes live the moment the
  console, the SDK or an API caller writes `[]`.

**Fix:** read `i.hotwords` once and branch on `Array.isArray` before filtering, so `undefined`
and `[]` stay distinct through `instruction()`; make the console write `hotwords: []` on an
explicitly cleared field with helper text saying what it means ("no terms; the model row's
list is not used"); keep `enabled: false` as the separate, explicit veto it already is
(`spec.py:751-757`).

**Sequencing hazard — call this out loudly.** `25-agents.ts:302` seeds
`ASR_INSTRUCTION.hotwords: [] as string[]`. Under the fixed semantics that literal becomes a
**veto**: the lexicon stage turns OFF and the model row's 20 terms stop reaching it, for every
seeded tenant, silently. **The seed must omit the key in the same commit**, and QW-12's
geometry-parity test must pin the resolved `term_count` at 20 so the change cannot slip in
unnoticed. Fixing M-57 without fixing the seed turns the correction stage off platform-wide.

### 5.4 One more tier gap found here

`postProcessing.lexicon.enabled` and `maxDistance` **are** reachable from the console — the
agent `ParametersForm` is schema-driven off `AGENT_PARAMETER_SCHEMAS`
(`parameters-form.tsx:524,543`), so the `lexicon` block at `agent-schemas.ts:516-535` renders
automatically. Good. But the bound a tenant can set there ranges `0.1–0.5` with **no guidance
and no preview**, and the value it tunes is the one §1.2 shows has a two-point-wide safe band.
Rider for the ST-7 admin surface: expose the bound with the dry-run panel beside it, and
refuse a value outside the measured band at publish once MR-1 has established one.

---

## 6. Test plan and measurement requests

### 6.1 Unit tests (CI `test-stt`, blocking — no live run, no GPU)

| # | Test | Asserts |
|---|---|---|
| U-1 | **Protected-vocabulary sweep (wired)** over the platform asset itself, all 20 seeded terms configured | **0 rewrites**. Plus a mutation case: with the gate disabled the same sweep is **non-zero** — otherwise the test proves nothing |
| U-2 | **Protected-vocabulary sweep (held-out)** over a committed held-out corpus: inflected forms, plurals, a general-English frequency slice disjoint from the asset, and a medical-English list minus the dictionary terms | **0 rewrites**. This is the test that measures whether the asset is *complete*; U-1 alone is a tautology |
| U-3 | **Recall corpus** — `septrioxone`, `sephotrioxone`, `Atorvacetam`, plus every mishearing BP-4 turns up | all snap, each with its expected stage and score |
| U-4 | **Named regressions** — `creating`, `creative`, `creation`, `certain`, `isopropyl`, `oxygen` | none rewritten, each with the rejection reason recorded |
| U-5 | **Per stage** — exact, space-agnostic, substring/affix, phonetic+graded, n-gram | one admit case and one refuse case each; `MIN_TOKEN_CHARS` bypassed on 1–2 only |
| U-6 | **Safety rules 1–9** | closed vocabulary; no split; no cross-punctuation; no cross-script by distance; idempotence (property test); blast-radius refusal; corrections reach `SegmentResult`; no fuzzy match adjacent to a numeric token |
| U-7 | **Phonetic key table** incl. the word-final `C`/`G` fix (D5-N4) | `creating -> KRTNK`, `tonic -> ...K`, `ceftriaxone -> SFTRKSN`/`KFTRKSN` |
| U-8 | **Latency** — 200-token final x 1070 entries x 5 stages | p95 ≤ 25 ms, hard fail > 60 ms, on the existing bench shape (`lexicon.py:56-67`) |
| U-9 | **Language parity (M-32)** — table over 6 modes x every `AiModelFormat` | batch and streaming return the same `(language, code_switching, initial_prompt)`; `('ml-en', WHISPER_CPP) -> (None, False, <pair prompt>)` |
| U-10 | **Resolver (M-57)** | `undefined` hotwords ⇒ model row's 20 + stage ON; `[]` ⇒ 0 terms + stage OFF; `enabled: false` with a non-empty list ⇒ stage OFF |
| U-11 | **Resolver (OD-E)** | an agent-tier `hotwordsInPrompt` is **ignored**; `sources.hotwordsInPrompt` is only ever `'model'`; the contradicting test at `build-resolved-asr-spec.test.ts:406` is deleted |
| U-12 | **Seed geometry parity** | resolved `term_count == 20` for `realtime-transcription` after the M-57 fix, so the seed hazard of §5.3 cannot land silently |

### 6.2 Measurement requests — **orchestrator only**

> **Sequencing constraint that governs all of these.** Today's run reports
> `keyterm_recall 0/21` on all three clips at `medical_wer` 0.885–0.935. **A lexicon on/off
> arm on the currently served configuration measures nothing** — both arms score 0/21,
> because nothing is transcribed for the stage to correct. Every arm below must run on a
> configuration where `keyterm_recall` is non-zero: either after BP-2 explains the collapse,
> or on the recorded working configuration (q8_0, {7,15}, `partialIntervalMs` 500, pair prompt
> OFF, which measured keyterm 1.0 / 1.0 / 0.875). Running MR-2 before that is wasted.

**MR-1 — Bound calibration (offline, no gateway, no GPU needed).**
*Arms:* the cross-product of strict ∈ {0.28, 0.34, 0.42} x relaxed ∈ {0.40, 0.45, 0.50}, with
the protected-vocabulary gate ON and OFF (18 arms).
*Fixture:* the platform protected-vocabulary asset + the held-out corpus (U-2) + the recall
corpus (U-3), all pinned by digest.
*Metric:* false rewrites per 100k words; recall over the recall corpus; p95 latency.
*Decision settled:* the shipped `(strict, relaxed)` pair and whether the word gate lets the
bound relax rather than tighten (§1.4). **This is the arm that decides QW-7's direction.**

**MR-2 — Lexicon on/off, served path (WS gateway).**
*Arms:* (a) lexicon OFF; (b) lexicon ON at today's `(0.34, 0.50)`; (c) lexicon ON at MR-1's
winner with the word gate.
*Fixture:* the three English clinical clips **on a working configuration** (see the constraint
above), N >= 5 on a quiet stack, model warmed.
*Metric:* `keyterm_recall`, `keyphrase_recall`, `medical_wer`, `stt_lexicon_corrections_total`,
`stt_lexicon_rejected_total{protected_word}`, commit p50.
*Decision settled:* whether the corrected bound holds keyterm recall while removing the false
rewrites — i.e. whether §1.4 is safe to ship.

**MR-3 — BP-4b arm (3), `hotwordsInPrompt` ON for ml-en. RESCOPED, and I recommend
de-prioritising it.**
*Why:* `whisper_cpp_asr.py:404-412` records the measurement this arm proposes to repeat:
"priming prompt + agent prompt + terms (what production ran after TASK-938) -> **2 %** Latin",
with "carcinoid" looping 30x on the terms-alone arm. The served configuration already has
priming prompt ON and agent prompt ON, so turning the switch on reproduces that recorded
configuration almost exactly. The prior measurement was offline with `language=en` pinned, so
re-measuring on the unpinned served path is defensible — but not on a live clinical surface.
*Rescoped arms:* offline only, on the 24 `STT_MLEN_EVAL_DIR` clips through the adapter
(never through the live gateway, never on a tenant an owner is using), `hotwordsInPrompt`
{off, on} x hotword count {0, 20}.
*Metric:* CER, **`latin_ratio` per clip**, repeat-loop count.
*Hard stop:* abort the arm at the first clip below 50 % Latin — do not complete the sweep.
*Decision settled:* whether the 2 % collapse is specific to the pinned-`en` offline setting or
reproduces unpinned. **Blocked on M-35's write path existing** (§5.1) — today it needs a direct
DB write.
*And note:* class 5 (abbreviation recall), which is what BP-4b arm (3) is trying to buy, is
better served by the ST-7 alias path (§3.3), which is post-hoc and cannot collapse a decode.

**MR-4 — Batch vs streaming language parity (M-32).**
*Arms:* one batch transcription job and one streaming session on the **same** English clip
(`cardiology_consult_01.wav`) through `realtime-transcription`, before and after the
`_language_for_engine` change.
*Metric:* `latin_ratio`, `medical_wer`, detected/pinned language echoed on the result.
*Decision settled:* confirms `language='ml'` is actually reaching the batch decode (and
whether it produces Malayalam-script output on English audio), and that the fix removes the
divergence. Re-baseline the ml-en batch CER entry afterwards.

**MR-5 — Corrected carry-forward (§2.3 rider).**
*Arms:* `_previous_text` taken from (a) the raw decode (today) vs (b) the lexicon-corrected
text.
*Fixture:* the 24 ml-en clips + the BP-4 replay.
*Metric:* CER, `keyterm_recall`, `script_mismatch` count, `repeat_rate`.
*Decision settled:* whether feeding a correction back as decoder context helps within a
session or sustains an error, given the repo's recorded script-mismatch experience.

**MR-6 — §2.5 class 4 reproduction (rides BP-4).**
*Arms:* the owner's encounter audio replayed through the current gateway on the served agent.
*Metric:* `article_digit_rate`, `number_form_agreement`, adjacent-repeated-numeric-token count,
each against the 24 ml-test reference labels' own rates.
*Decision settled:* whether class 4 reproduces on the unpinned served path at all — which
decides whether §3 needs anything beyond QW-10's repetition guard.

**MR-7 — ST-7 end to end, once the dictionary entity exists.**
*Arms:* dictionary OFF / exact+alias stages only / all five stages.
*Fixture:* the BP-4 replay + a bilingual keyterm fixture (blocked on D5-N5).
*Metric:* `abbrev_recall` (target >= 0.7), `clinical_substitution_rate`, CER (not worse than
baseline + 0.02), commit p50 (+ <= 50 ms), `stt_lexicon_latency_seconds` p95 (<= 25 ms),
blast-radius WARN count (0).
*Decision settled:* whether the alias stages alone carry class 5, i.e. whether stages 3–5 are
worth their complexity.

---

## 7. New defects found in this area

| # | Claim | Evidence | Sev | Suggested fix |
|---|---|---|---|---|
| **D5-N1** | ST-7's data-model line is self-contradictory under the owner rule: it says the clinical dictionary is "tenant **content cascaded** per the rules", but content is **cloned** and never resolved across tenants at runtime. Left as written, an implementer builds a tenant->SYSTEM runtime read of one tenant's authored vocabulary. | README `§3 Wave 3 ST-7`; `00-project-context.md` §"Content is cloned; configuration cascades" (TASK-890 OD-M) | med | Reword ST-7 to "tenant content, cloned from the SYSTEM reference set, never read cross-tenant at runtime"; `SYSTEM_SHARED_READ_MODELS` not widened (§2.2) |
| **D5-N2** | A green unit test asserts an agent-tier `hotwordsInPrompt` precedence that the agent schema makes unreachable (`decoding` is `additionalProperties: false` with no such key), so CI currently certifies a two-tier behaviour that cannot exist. | `build-resolved-asr-spec.test.ts:406-410` vs `agent-schemas.ts:421` (block start) and `:420-495` (properties) | med | Delete the agent read (`build-resolved-asr-spec.ts:328-332`) and that test; add U-11 asserting the agent tier is ignored |
| **D5-N3** | `hotwordsInPrompt` is unwritable from **both** governed tiers, not one: the agent schema forbids it AND `AsrProfileDecodingRequest` omits it, so a `PATCH admin/ai-models/:id` carrying it is rejected **400** by `forbidNonWhitelisted` rather than silently dropped. BP-4b arm (3) therefore cannot run at all today. | `agent-schemas.ts:420-495`; `asr-profile.request.ts` (no such field); `05-nestjs-api.md` §Bootstrap Facts; `model-form-sheet.tsx:173` | med | M-35's fix, promoted from Wave 2 to a BP-wave prerequisite (§5.1) |
| **D5-N4** | `phonetic_keys` takes the front-vowel branch at the **last letter** of a word: `following` is `""` (`lexicon.py:158`) and `"" in "EIY"` is `True` (substring, not membership), so word-final `C` keys as `S`/`K` and word-final `G` as `J`/`K`. `creating` keys `KRTNJ`/`KRTNK`, not `KRTNK` alone. Invisible on the two designed cases; wrong for every word ending in C or G. (`_VOWELS` is a `frozenset`, so the vowel checks are unaffected.) | `lexicon.py:158, 168-177, 185-195, 107` | low | Guard `following and following in "EIY"`, or compare against a set; regenerate any stored key fixtures (U-7) |
| **D5-N5** | `abbrev_recall` — the metric §2.5 class 5 and BP-4b arm (3) are both gated on — **cannot be computed**: all three keyterm fixtures are Latin-only with no Malayalam forms, no synonym map and no abbreviations, and the §5 protocol's "synonym map, both scripts" does not exist. | `apps/stt/tests/e2e/fixtures/clinical/{discharge_summary_01,cardiology_consult_01,medication_review_01}.keyterms.json` | med | Extend the fixture schema to `{ canonical, aliases[], scripts[] }` and add the abbreviation set (BP, CBC, LFT) in both scripts, before any arm that gates on `abbrev_recall` |
| **D5-N6** | Promoting the per-correction log to INFO as QW-7 asks would put transcript text (`original`) in the log at INFO on every corrected drug name, contradicting the file's own stated PHI posture for `script_mismatch` ("the log is the only place a transcript can be read without decrypting a `ContextItem`"). | `inference.py:325-335` (DEBUG, carries `original`/`replacement`) vs `inference.py:352-360` (WARN, deliberately carries no text) | med | Split the line: INFO carries `term` (configured vocabulary) + `stage` + `score` + `original_len`; DEBUG keeps `original` (§1.6) |
| **D5-N7** | The lexicon stage runs on **partials** (`inference.py:1335`), whose output feeds `LocalAgreementPolicy`'s settled prefix, and `_best_at` prefers **wider windows first** (`lexicon.py:492`). A single-word correction made at partial N can be superseded by a phrase correction at N+1, mutating characters already counted as stable and charging the difference to `committed_revision_rate`. Latent today (all 20 seeded terms are single-token) and live the moment any tenant adds a two-word term. | `inference.py:1335`; `lexicon.py:473-495`; `commit_policy.py:265-273` | low | Keep the cheap corrector on partials but restrict it to width-1 windows, or apply width-N corrections only on finals (§2.3); add a case to the jitter-oracle test |
| **D5-N8** | There is no Prometheus metric for the correction stage at all — only a DEBUG log and a teardown-summary field that nothing exports, so neither the false rewrites of M-31 nor any future fix is observable in production. | `inference.py:192, 326`; `session_manager.py:4230-4232`; no `lexicon` match in `apps/stt/src/stt/core/metrics.py` | med | The four counters of §1.6, folded into BP-5 |
| **D5-N9** | F9-K2's headline (CER 0.234 -> 0.082, 64.9 %) is cited beside ST-7 as if it were the expected gain of a deterministic string matcher. The study measured **dictionary-augmented LLM** post-processing; a string matcher recovers class 5 and part of 1/3 and recovers **none** of class 6. | README `§3 ST-7` + Appendix C F9-K2 (`PMC13344086`, Korean-English); §2.5 classes 5 and 6 | med | Split the claim: attribute the alias/abbreviation recovery to the deterministic stage; move the LLM corrector to its own owner-decided item on the `apps/text` plane (§2.6) |
| **D5-N10** | The batch language reading diverges from streaming in **three** fields, not the one M-32 names: `language` (`'ml'` vs `None`), `code_switching` (`True` vs `False` — meaningless for whisper.cpp, which the streaming path knows at `language_modes.py:469` and the batch path does not), and the **pair priming prompt** (absent vs present). So BP-2's prompt arms cannot transfer to the batch CER gate either. | `spec.py:561-582, 703` vs `session_manager.py:2253-2255` and `language_modes.py:449-471` | med | `_language_for_engine`, carrying `initial_prompt` through (§4.2); U-9 |
| **D5-N11** | `MIN_TOKEN_CHARS = 4` makes every 2–3 letter abbreviation (`BP`, `CBC`, `LFT`) structurally uncorrectable, so the class-5 abbreviation loss could not be fixed by adding them to the hotword list even if someone tried. | `lexicon.py:101`; `_window_text` `:641-642` | low | Bypass the floor for exact and space-agnostic matches only (§2.4) |

---

## 8. Owner decisions this area needs

| Id | Question | Recommendation |
|---|---|---|
| **OD-E** (existing) | `hotwordsInPrompt`: one tier or two | **One — the model row.** It is a property of the weights; the sibling `initialPrompt` is already one-tier; the agent tier is dead by construction. Enforce it by **deleting** the agent read, not by documenting the rule (§5.2) |
| **D5-OD-a** (new) | Where the platform protected-vocabulary list lives | Bucket-staged versioned asset addressed by a `db-config` pointer on the ASR row, with a small tenant delta on the dictionary entity (§1.5). It is neither an env var, nor a code literal, nor a `GlobalSetting` value |
| **D5-OD-b** (new) | Is the clinical dictionary content or configuration | **Content**, cloned from the SYSTEM reference set, never read cross-tenant at runtime (§2.2). Resolves D5-N1 |
| **D5-OD-c** (new) | Does an ITN / number-denormalisation stage belong in `apps/stt` | **No.** Measure class 4 first (MR-6); if it reproduces it is an OD-I re-fine-tune input, not a post-processing stage. Option (e) of §3.2 costs the alternative if overruled |
| **D5-OD-d** (new) | Sequencing of BP-4b arm (3) | De-prioritise and rescope to offline-only with a `latin_ratio` hard stop; it repeats a configuration the repo already measured at 2 % Latin. Class 5 goes through the ST-7 alias path instead (MR-3) |
| **D5-OD-e** (new) | Whether an LLM clinical corrector (what F9-K2 actually measured) is in scope at all | Not in ST-7. A separate item on the `apps/text` plane, finals-only, applied to the durable transcript and not the live caption, after the deterministic stage has a number (§2.6) |

/**
 * TASK-939 OD-2(a) — the TURN contract for a partial-summary flush.
 *
 * ## What changed, and why it had to be a shape change
 *
 * A realtime turn used to emit the WHOLE document: the response schema demanded every section's
 * full body, the prior note was handed back as an unlabelled `\n\n` join of section bodies, and the
 * seeded template instructed *"re-emit the whole note each time"*. So every turn rewrote text the
 * clinician had already read — the note tore down and re-rendered every ~20 seconds — and every
 * turn paid output tokens for the entire note rather than for what had just been said.
 *
 * The instruction to "keep prior content" was already there, in two places. It did not hold,
 * because nothing PREVENTED a rewrite: merge was a request, not a mechanism. Here prior text is
 * not re-emittable at all. A turn says:
 *
 * | Field | Meaning |
 * |---|---|
 * | `addition` | text to APPEND to this section. The ordinary case |
 * | `revision` + `contradiction` | replace this section, because the new transcript contradicts what is written |
 *
 * Byte-stability is then a property of the shape rather than of the model's cooperation, and a
 * turn's cost is proportional to what was actually said.
 *
 * ## Why `revision` is one field and not a list of find/replace edits
 *
 * A `corrections[]` of `{find, replace}` pairs is the obvious alternative and it is worse: an LLM
 * emitting a `find` string that does not match the stored text byte-for-byte produces a SILENT
 * no-op, so a correction the clinician needed simply does not happen and nothing reports it. A
 * whole-section `revision` always applies, and the `contradiction` requirement is what stops it
 * becoming the old behaviour under a new field name — exactly the shape of the store's existing
 * `deletion-without-contradiction` rule, for the same reason: a model silently replacing what it
 * said two turns ago is indistinguishable, to a reader, from the clinician never having said the
 * first thing.
 *
 * ## Scope
 *
 * This is the REALTIME turn schema only. `CompiledDocumentTemplate.responseFormat` is a PERSISTED
 * artifact (`DocumentTemplateVersion.compiled`) and the finalisation path's contract, so it is
 * untouched and needs no recompile or `compilerVersion` bump: the turn schema is DERIVED here, at
 * call time, from the same `sectionKeys` and `checklist`.
 *
 * ## TASK-1001 OD-5 — the append guard is per SENTENCE, not per addition
 *
 * The guard above was `!before.includes(addition)`: a case-, whitespace- and punctuation-sensitive
 * containment test of the WHOLE trimmed addition. One decrypted consultation showed what that
 * misses. Two genuine blocks `S1` and `S2` were stored (joined, as storage always joins, with
 * `\n\n`), and five further copies accumulated on top of them: `S1 + S2` restated as one addition
 * joined by a single SPACE — so not a contiguous substring of `S1\n\nS2` — twice; `S1' + S2` where
 * `S1'` differed by one space inside a drug name; `S2` then `S1` reordered; and `S2` with its doses
 * respaced (`1000mg` → `1000 mg`). Every shape sails through a whole-addition containment test.
 *
 * **Every one of them was an exact-sentence repeat modulo whitespace, punctuation or ordering — not
 * one was a paraphrase.** That is why the fix is exact-normalised SENTENCE dedup and nothing more.
 * Similarity or paraphrase matching would drop clinical content the clinician actually said, and a
 * silently missing sentence is a worse defect than a duplicated one (OD-5).
 *
 * Two rules keep it on the safe side of that line:
 *
 * - normalisation is for COMPARISON ONLY — every surviving sentence is appended in its original
 *   text, in its original order. Nothing lowercased or respaced is ever written; and because
 *   normalisation removes whitespace rather than digits, `1000mg` and `100mg` stay distinct, so a
 *   sentence differing in a number, dose, date or laterality is NEW and is appended.
 * - a sentence is eligible to be dropped only when it is at least two words (see `splitSentences`).
 *
 * ## TASK-1001 (wave 2) — a repeat ACROSS sections is FLAGGED, never dropped
 *
 * The per-section guard above cannot see one turn writing the same paragraph into two DIFFERENT
 * sections (observed: `family_history` and `diagnosis`), and by design it must not: the same
 * clinical fact legitimately belongs in two sections all the time — a drug under treatment history
 * AND under the plan of care — so deleting a cross-section repeat could silently lose content,
 * which OD-5 ranks worse than a duplicate. The owner's decision (2026-09-23) is therefore to FLAG
 * it: the later section's write carries a `duplicate` annotation naming the section that already
 * holds the text, and the write itself is byte-for-byte what it would have been without the rule.
 * See `crossSectionDuplicates` for the rule, and why it — unlike the dedup above — may match
 * near-duplicates.
 */
import type { CompiledDocumentTemplate, CompiledResponseFormat } from '../../../document-template/document-template-compiler';
// TASK-1000 OD-7 — the ONE sentinel both planes must agree about. Imported rather than
// re-declared so the write guard below and `buildStructuredSummary`'s render guard can never
// drift apart; `document-shape-parser` imports only types, so this closes no cycle.
import { RUNNING_SUMMARY_TITLE } from '../document-shape-parser';
import type { LiveSummarySectionDto } from '../dto';
import type { SectionAnnotationDto } from './dto/section-patch.dto';

/** One section's contribution to a turn. Every field is optional — a quiet section says nothing. */
export interface TurnSection {
  /** Text to APPEND. */
  readonly addition?: string;
  /** Replacement body, admitted only with a `contradiction` (or on a section that is still empty). */
  readonly revision?: string;
  /** What in the NEW transcript contradicts the text being replaced. */
  readonly contradiction?: string;
}

/** A parsed turn, keyed by the compiled template's section keys. Absent key ⇒ nothing for it. */
export type ParsedTurn = Readonly<Record<string, TurnSection>>;

/** One section write this turn implies, in the shape `DocumentSectionStore.applyFlushPatch` takes. */
export interface TurnSectionWrite {
  readonly sectionKey: string;
  readonly title: string;
  readonly idx: number;
  readonly mode: 'append' | 'replace';
  /** The NEW PART for `append`; the whole new body for `replace`. */
  readonly content: string;
  readonly contradiction?: { readonly reason: string };
  /**
   * TASK-1001 (wave 2) — `duplicate` annotations for runs of THIS write that another section of
   * the same document already carries. Absent when there are none, so every write the rule does
   * not concern keeps its exact pre-existing shape.
   *
   * **Offsets index THIS WRITE's `content`** — for an `append`, the new part — not the section
   * body: only the store knows the body the append actually lands on, so it re-bases them
   * (`SectionWriteInput.contentAnnotations`). Nothing here changes `content`; a flag never drops,
   * alters, reorders or truncates text.
   */
  readonly duplicates?: readonly SectionAnnotationDto[];
}

export type TurnRefusalReason = 'revision-without-contradiction' | 'addition-already-present';

export interface TurnRefusal {
  readonly sectionKey: string;
  readonly reason: TurnRefusalReason;
}

export interface AppliedTurn {
  /** The note AFTER this turn, in the template's authored order — the publishable section list. */
  readonly sections: LiveSummarySectionDto[];
  /** Only the sections this turn actually changed. A quiet section produces no write. */
  readonly writes: TurnSectionWrite[];
  /** Refused contributions, for PHI-safe logging and the churn metric. */
  readonly refusals: TurnRefusal[];
  /** TASK-1001 — sentences dropped from additions because the section already held them. */
  readonly droppedSentenceCount: number;
  /**
   * TASK-1001 (wave 2) — runs this turn wrote that ANOTHER section already carries, turn-wide.
   * Counted per flagged run (one `duplicate` annotation each), never per sentence. Nothing was
   * dropped for them; this is the count `repetition_pressure` adds to its sum.
   */
  readonly crossSectionDuplicateCount: number;
  /**
   * TASK-1022 (D-GROUND) — sentences dropped from CURRENT-visit sections because only the reference
   * blocks (same-day earlier visit, test results) supported them. Absent when no grounding input was
   * supplied, so every caller that does not pass one keeps its exact pre-existing result shape.
   */
  readonly ungroundedSentenceCount?: number;
}

/**
 * TASK-1022 (D-GROUND) — what a turn may be grounded in, supplied by the flush that built its prompt.
 *
 * `transcript` is everything the encounter has said so far (the whole transcript, not this turn's
 * delta, plus any clinician context notes): a sentence supported there is grounded whatever else
 * supports it. The two reference blocks are the texts `buildTextUserPrompt` appends after the
 * "REFERENCE ONLY" line — the ones a small model was observed copying into today's sections.
 */
export interface TurnGrounding {
  readonly transcript: string;
  /** The `SAME-DAY EARLIER VISIT(S)` block's body. */
  readonly sameDayPrequel?: string;
  /** The `TEST RESULTS` block's body. */
  readonly testResults?: string;
}

/**
 * The strict `json_schema` a turn decodes against.
 *
 * Every section key is present and `required`, with optionality carried by NULLABILITY rather than
 * by absence from `required` — the same rule the document compiler documents, because dropping a
 * key from `required` under `strict: true` disables strict decoding instead of making the field
 * optional.
 */
export function buildTurnResponseFormat(compiled: CompiledDocumentTemplate): CompiledResponseFormat {
  const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));
  const properties: Record<string, unknown> = {};

  for (const key of compiled.sectionKeys) {
    properties[key] = {
      type: ['object', 'null'],
      additionalProperties: false,
      description: `Your contribution to "${titles.get(key) ?? key}" THIS TURN. null if the new transcript said nothing about it.`,
      properties: {
        addition: {
          type: ['string', 'null'],
          description: 'New text to ADD to this section. Never repeat text the section already contains.',
        },
        revision: {
          type: ['string', 'null'],
          description: 'The section rewritten, ONLY when the new transcript contradicts what is already written. Requires `contradiction`.',
        },
        contradiction: {
          type: ['string', 'null'],
          description: 'What in the NEW transcript contradicts the text you are replacing. Required whenever `revision` is set.',
        },
      },
      required: ['addition', 'revision', 'contradiction'],
    };
  }

  return {
    type: 'json_schema',
    strict: true,
    json_schema: {
      // Deliberately the template's OWN title, not a decorated one: the committed tests assert the
      // tenant's shape reaches the provider, and a cosmetic rename would read as a contract change
      // where the contract is carried by the properties.
      title: compiled.title,
      type: 'object',
      additionalProperties: false,
      properties,
      required: [...compiled.sectionKeys],
    },
  };
}

/** The prose half of the contract, for the prompt. Kept beside the schema so the two cannot drift. */
export function turnInstruction(compiled: CompiledDocumentTemplate): string {
  return [
    '',
    '',
    'WHAT TO EMIT THIS TURN:',
    'For each section, report only your CONTRIBUTION — never the section as a whole:',
    '  • "addition": text to ADD. This is the ordinary case. Never restate anything the section already contains.',
    '  • "revision" + "contradiction": the section rewritten, and what in the NEW transcript contradicts the text you are replacing. Use this ONLY for a genuine contradiction — a revision without a contradiction is discarded and your rewrite is lost.',
    '  • null for a section the new transcript said nothing about. Most sections, most turns, are null.',
    `Sections, by key: ${compiled.sectionKeys.join(', ')}.`,
    'The note already written is shown to you for context only. Do not reproduce it: the text you already wrote is kept for you automatically, and a clinician is reading it as you write.',
  ].join('\n');
}

/** Strip a ```json fence, which models emit unprompted. */
function unfence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * A serialisation artifact a model emits where the schema declares JSON `null`.
 *
 * Found by the live replay: `gemma-4-e2b-it-qat` answered `{"addition": "null"}` for sections it had
 * nothing to say about, and the fold appended that as prose — the persisted note literally read
 * `null` above the one real sentence. The accumulation invariant HELD throughout (it accumulated
 * `"null"` faithfully), which is exactly why the churn metric could not catch it.
 *
 * Deliberately NARROW — only a value whose ENTIRE trimmed text is one of these. `None` and `Nil`
 * are legitimate clinical shorthand; discarding those would lose real content, which is a worse
 * defect than the one this prevents. (TASK-1022: a whole-sentence `N/A` is dropped, but by the
 * separate placeholder guard in `asContent`, not here.)
 */
const JSON_NULL_SENTINELS: ReadonlySet<string> = new Set(['null', 'undefined']);

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return JSON_NULL_SENTINELS.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

/**
 * TASK-1022 — the section CONTENT a turn carries (`addition` / `revision`): `asText`, minus every
 * "nothing stated" placeholder sentence (see `withoutPlaceholderSentences`). `contradiction` is a
 * reason, not content, and keeps plain `asText`.
 */
function asContent(value: unknown): string | undefined {
  const text = asText(value);
  if (text === undefined) return undefined;
  const kept = withoutPlaceholderSentences(text);
  return kept.length > 0 ? kept : undefined;
}

/**
 * Parse a turn. `null` means "this was not a turn document" — the caller falls back, exactly as it
 * already does when `parseDocumentJson` returns null.
 *
 * A turn naming NO section the template declares is `null` rather than an empty turn: that is an
 * output written against some other contract, and treating it as "nothing to add" would silently
 * discard a whole generation.
 */
export function parseTurnJson(raw: string, compiled: CompiledDocumentTemplate): ParsedTurn | null {
  if (!raw || raw.trim().length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;

  const record = decoded as Record<string, unknown>;
  const turn: Record<string, TurnSection> = {};
  let sawDeclaredKey = false;

  for (const key of compiled.sectionKeys) {
    if (!(key in record)) continue;
    const value = record[key];
    // A STRING under a section key is the DOCUMENT contract — "here is the whole section" — not a
    // turn. Answering `null` here sends it to the whole-document degrade, which is correct and
    // lossless. Reading it as a turn instead would see every section contributing nothing and
    // publish an EMPTY note, silently discarding the generation. `null` is NOT such a signal: a
    // turn legitimately says null for a section the transcript did not touch, and a turn in which
    // every section is null is simply a quiet turn.
    if (typeof value === 'string') return null;
    sawDeclaredKey = true;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;

    const entry = value as Record<string, unknown>;
    const section: TurnSection = {
      ...(asContent(entry.addition) ? { addition: asContent(entry.addition)! } : {}),
      ...(asContent(entry.revision) ? { revision: asContent(entry.revision)! } : {}),
      ...(asText(entry.contradiction) ? { contradiction: asText(entry.contradiction)! } : {}),
    };
    if (Object.keys(section).length > 0) turn[key] = section;
  }

  return sawDeclaredKey ? turn : null;
}

/**
 * The DEGRADE path: treat a WHOLE-DOCUMENT output as a turn.
 *
 * Not every provider honours `response_format` — Ollama ignores it by design, which is why the
 * flush already carries a prose parser as its final fallback. Such a provider, asked for a turn,
 * may still answer with the whole document. Rather than discard the generation (the clinician
 * would see nothing) or mis-read it as additions (the note would double), this reproduces the
 * PRE-TASK-939 behaviour exactly: every non-empty section becomes a `replace`.
 *
 * The caller must record that it took this path. It is the old behaviour — the clinician sees the
 * whole note rewritten — so a tenant sitting on it permanently is a finding, not a detail, and the
 * churn metric is what surfaces it.
 *
 * An empty section emits NO write, so a provider that omits a section cannot blank one the note
 * already has. (The store would refuse that anyway as `deletion-without-contradiction`; not
 * issuing the write keeps the refusal out of the log when there is nothing to refuse.)
 */
export function wholeDocumentAsTurn(parsed: readonly LiveSummarySectionDto[], compiled: CompiledDocumentTemplate): AppliedTurn {
  // The parsed list is passed through VERBATIM rather than re-keyed onto `sectionKeys`. The prose
  // parser has its own fallback — a single `Running Summary` section carrying the whole output when
  // no heading matched — and re-keying would silently discard it, publishing an empty note for a
  // generation that actually said something. Positional key derivation (with a title-slug fallback)
  // is exactly what `publishSectionPatches` did before this ticket, so the degrade is faithful.
  const writes: TurnSectionWrite[] = [];

  for (const [idx, section] of parsed.entries()) {
    const content = section.content ?? '';
    if (content.trim().length === 0) continue;
    // TASK-1000 OD-7 — the parser's fallback is NOT a section, so it never becomes a write.
    //
    // `parseDocumentSections` answers `[{ title: RUNNING_SUMMARY_TITLE, content: <all of it> }]`
    // when fewer than two headings matched: a note whose partition is UNKNOWN. Keying that
    // POSITIONALLY onto `sectionKeys[0]` labels an arbitrary blob as the template's first
    // clinical section — which is how a truncated JSON turn document became one consultation's
    // `patient_demographics`. It still passes through on `sections` below, so the running-summary
    // view keeps rendering it for the provider this degrade path exists for (one that ignores
    // `response_format` and answers in prose); it simply never overwrites a clinical section.
    //
    // `buildStructuredSummary` makes the same guard for the same sentinel, and for the same
    // reason — this is that rule applied to the WRITE plane rather than the render plane.
    if (section.title.trim() === RUNNING_SUMMARY_TITLE) continue;
    const sectionKey = compiled.sectionKeys[idx] ?? section.title.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    writes.push({ sectionKey, title: section.title, idx, mode: 'replace', content });
  }

  // `droppedSentenceCount` is 0 by construction, not by omission: this path emits `replace` writes,
  // which overwrite rather than accumulate, so there is nothing for sentence dedup to protect.
  // `crossSectionDuplicateCount` is 0 for the same reason: the cross-section flag concerns text a
  // TURN appends (or first writes). A whole-document degrade rewrites every section each flush, so
  // flagging it would re-flag the entire note on every turn and measure the degrade, not a repeat.
  return { sections: [...parsed], writes, refusals: [], droppedSentenceCount: 0, crossSectionDuplicateCount: 0 };
}

/**
 * Resolve the prior body of each section.
 *
 * `LiveSummarySectionDto` carries a TITLE and no key, and `publishSectionPatches` already pairs the
 * two POSITIONALLY (`sectionKeys[idx]`), so index is the primary alignment. It is only valid when
 * the lengths agree — a prior note that fell back to the single "Running Summary" section does not
 * align with a four-section template — so a mismatch matches on title instead and otherwise treats
 * the section as empty. Guessing would silently attribute one section's text to another.
 */
function priorByKey(prior: readonly LiveSummarySectionDto[], compiled: CompiledDocumentTemplate): Map<string, string> {
  const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));
  const aligned = prior.length === compiled.sectionKeys.length;
  const byTitle = new Map(prior.map((section) => [section.title.trim().toLowerCase(), section.content ?? '']));

  return new Map(
    compiled.sectionKeys.map((key, idx) => {
      if (aligned) return [key, prior[idx]?.content ?? ''];
      const title = (titles.get(key) ?? key).trim().toLowerCase();
      return [key, byTitle.get(title) ?? ''];
    }),
  );
}

/** TASK-1001 — what ends a sentence. `…` is included because models emit it where they elide. */
const SENTENCE_TERMINATORS: ReadonlySet<string> = new Set(['.', '!', '?', '…']);

/** Non-global on purpose: a `g` regex carries `lastIndex` between `.test()` calls. */
const WHITESPACE = /\s/;

interface Sentence {
  /** The sentence EXACTLY as written (trimmed). Never the normalised form — that is comparison-only. */
  readonly text: string;
  /** The whitespace that followed it, so the survivors re-join in the author's own layout. */
  readonly separator: string;
  /**
   * TASK-1001 (wave 2) — where `text` sits in the body that was split: `body.slice(start, end)`
   * is `text`, exactly. The cross-section flag needs it to address a span; the dedup ignores it.
   */
  readonly start: number;
  readonly end: number;
}

/**
 * Split a body into sentences.
 *
 * Two boundary rules, and the second one is the load-bearing one:
 *
 * 1. **A line break always ends a sentence**, whatever punctuation it carries. Storage joins blocks
 *    with `\n\n`, and a clinical line ("Inj ATG 5 mg IV") frequently carries no terminator at all —
 *    without this rule a stored block and the same block restated inline would not compare equal.
 * 2. **A terminator ends a sentence only when whitespace, or the end of the body, follows it.** That
 *    single condition IS the decimal rule: in `1.05 ng/mL` and `488.2 IU/mL` the `.` is followed by
 *    a DIGIT, so it is never a boundary. It matters twice over — a splitter that shattered
 *    `Serum TSH 1.05 ng/mL.` into `Serum TSH 1.` and `05 ng/mL.` would then drop the first fragment
 *    as "already present" and append a bare `50 ng/mL.` to the note, losing the analyte and turning
 *    a dedup into a data-corruption bug.
 *
 * Note what this deliberately does NOT do: it has no abbreviation dictionary, so `Inj. ATG 5 mg.`
 * splits into `Inj.` and `ATG 5 mg.`. That is harmless because both sides of the comparison are
 * split by the same rule, and because a one-word sentence is never eligible to be dropped
 * (`withoutSentencesAlreadyPresent`) — which is what stops `Inj.` being deleted from a new drug
 * line just because an older line already carried it.
 */
function splitSentences(body: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;
  let cursor = 0;

  const whitespaceRunEnd = (from: number): number => {
    let at = from;
    while (at < body.length && WHITESPACE.test(body[at]!)) at += 1;
    return at;
  };

  const take = (end: number, separatorEnd: number): void => {
    const raw = body.slice(start, end);
    const text = raw.trim();
    if (text.length > 0) {
      // `trim()` removes the same leading whitespace `trimStart()` does, so this is where `text`
      // begins inside `body`.
      const textStart = start + (raw.length - raw.trimStart().length);
      sentences.push({ text, separator: body.slice(end, separatorEnd), start: textStart, end: textStart + text.length });
    }
    start = separatorEnd;
  };

  while (cursor < body.length) {
    const char = body[cursor]!;

    if (char === '\n' || char === '\r') {
      const separatorEnd = whitespaceRunEnd(cursor);
      take(cursor, separatorEnd);
      cursor = separatorEnd;
      continue;
    }

    if (SENTENCE_TERMINATORS.has(char)) {
      let end = cursor;
      while (end < body.length && SENTENCE_TERMINATORS.has(body[end]!)) end += 1;
      if (end >= body.length || WHITESPACE.test(body[end]!)) {
        const separatorEnd = whitespaceRunEnd(end);
        take(end, separatorEnd);
        cursor = separatorEnd;
      } else {
        cursor = end;
      }
      continue;
    }

    cursor += 1;
  }

  if (start < body.length) take(body.length, body.length);
  return sentences;
}

/**
 * The comparison key. Lowercase, ALL whitespace removed, trailing sentence punctuation stripped.
 *
 * That is exactly enough to equate the observed duplicates — `tg, atg` with `tg,atg`, `1000mg` with
 * `1000 mg`, a block restated with a different line break — and no more. Digits are untouched, so
 * `1000mg` and `100mg` normalise apart and the dose-change case is NEW text, not a duplicate.
 */
function normaliseForComparison(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.!?…]+$/, '');
}

/**
 * The two-word rule, stated ONCE: a sentence is eligible when it has at least two words and
 * something left after normalisation. The dedup may DROP only an eligible sentence (see the
 * reasoning in `withoutSentencesAlreadyPresent`); the cross-section flag builds its runs out of
 * eligible sentences only, so a lone `Inj.` can neither be deleted nor make a run.
 */
function isEligibleSentence(text: string): boolean {
  return WHITESPACE.test(text) && normaliseForComparison(text).length > 0;
}

interface DedupedAddition {
  /** The surviving sentences, in their ORIGINAL text and original order. Empty ⇒ nothing is new. */
  readonly text: string;
  readonly dropped: number;
}

/** TASK-1001 OD-5 — drop from `addition` the sentences `before` already holds. */
function withoutSentencesAlreadyPresent(before: string, addition: string): DedupedAddition {
  const sentences = splitSentences(addition);

  // The pre-TASK-1001 whole-addition guard, KEPT as a floor rather than replaced. It covers the one
  // case sentence dedup deliberately declines to: an addition that is a single token already
  // written verbatim (see the two-word rule below).
  if (before.includes(addition)) return { text: '', dropped: sentences.length };

  const present = new Set(
    splitSentences(before)
      .map((sentence) => normaliseForComparison(sentence.text))
      .filter((key) => key.length > 0),
  );

  const kept: Sentence[] = [];
  let dropped = 0;

  for (const sentence of sentences) {
    // A sentence may be DROPPED only when it is at least two words. Splitting on
    // "<terminator><whitespace>" cuts a clinical abbreviation — `Inj.`, `Tab.`, `Dr.` — into a
    // token of its own, and such a token is present in nearly any section that already names an
    // injection. Dropping it would silently delete the route from the NEXT drug line, which is
    // precisely the content loss OD-5 ranks worse than a duplicated sentence. A genuine restatement
    // of clinical content is never one word.
    const key = normaliseForComparison(sentence.text);
    if (isEligibleSentence(sentence.text) && present.has(key)) {
      dropped += 1;
      continue;
    }
    kept.push(sentence);
  }

  return {
    text: kept
      .map((sentence) => `${sentence.text}${sentence.separator}`)
      .join('')
      .trim(),
    dropped,
  };
}

// =================================================================================================
// TASK-1001 (wave 2) — cross-section repeats: FLAGGED, never dropped
// =================================================================================================

/**
 * How similar two sentences must be to count as the same one for the cross-section FLAG: the
 * Jaccard similarity of their token sets, inclusive.
 *
 * ## Why this path may match near-duplicates when the dedup above may not
 *
 * OD-5's caution about similarity matching is about DROPPING: a paraphrase the dedup mistook for a
 * repeat would silently delete something the clinician said. This path never removes anything —
 * the worst a false match can do is put a flag on text that was fine — so the argument that kept
 * the dedup exact does not apply here, and the observed case REQUIRES a looser match: the
 * `diagnosis` copy of the `family_history` paragraph read `that symptoms such as` where the
 * original read `that many of the symptoms such as`, so only its SECOND sentence was an exact
 * repeat and an exact-only rule would have flagged nothing. The tests' same-shape reconstruction
 * of that sentence pair scores 18/20 = 0.9.
 *
 * 0.8 still keeps apart two sentences that differ by a clinical word or two (`dry cough … at night`
 * against `wet cough … at dawn` is 10/14 ≈ 0.71). What it does NOT keep apart is a long sentence
 * whose only difference is a negation (`no`): that pair is flagged, which is the acceptable failure
 * of a rule that only flags.
 */
export const CROSS_SECTION_DUPLICATE_JACCARD = 0.8;

/**
 * The shortest run of consecutive eligible sentences that is flagged. A single shared sentence is
 * the ordinary case — the same vital sign in `objective` and `assessment`, the same drug line in
 * treatment history and the plan — and flagging it would put a flag on most notes.
 */
export const CROSS_SECTION_DUPLICATE_MIN_RUN = 2;

/**
 * The tokeniser for the similarity comparison. A NUMBER is one token — a run of digits with an
 * optional internal decimal point, so `1.05` stays `1.05` and never `1` + `05` — and a WORD is a
 * run of letters (with their combining marks, so a Malayalam word is not split at every vowel
 * sign). Everything else separates. Digits never fuse with letters: `1000mg` is `1000` + `mg`, so
 * the number is always visible to the digit rule below.
 */
const MATCH_TOKEN = /\p{N}+(?:\.\p{N}+)?|[\p{L}\p{M}]+/gu;
/** Non-global on purpose — see `WHITESPACE`. */
const NUMBER_TOKEN = /^\p{N}/u;

/** A sentence in the three forms the cross-section comparison reads. Comparison-only, never written. */
interface MatchForm {
  /** The dedup's own comparison key: equal keys are a match whatever the similarity says. */
  readonly key: string;
  readonly tokens: ReadonlySet<string>;
  /**
   * The number tokens as a sorted MULTISET: the same numbers in another order compare equal, and a
   * number that appears twice in one sentence must appear twice in the other.
   */
  readonly numbers: string;
}

function matchForm(text: string): MatchForm {
  const tokens = text.toLowerCase().match(MATCH_TOKEN) ?? [];
  return {
    key: normaliseForComparison(text),
    tokens: new Set(tokens),
    numbers: tokens
      .filter((token) => NUMBER_TOKEN.test(token))
      .sort()
      .join(' '),
  };
}

/**
 * Two sentences are the same sentence, for the FLAG, when either:
 *  - their normalised forms are equal (the dedup's own rule — so everything the dedup would call a
 *    repeat, this calls a repeat too); or
 *  - their token sets have a Jaccard similarity of at least {@link CROSS_SECTION_DUPLICATE_JACCARD}
 *    AND their number tokens are identical as a multiset.
 *
 * The number condition is not a refinement, it is the safety rule: `1000 mg` against `100 mg`, a
 * changed date, a changed count or a changed lab value is DIFFERENT clinical content however many
 * words the two sentences share, and is never reported as a repeat.
 */
function sentencesMatch(a: MatchForm, b: MatchForm): boolean {
  if (a.key.length > 0 && a.key === b.key) return true;
  if (a.numbers !== b.numbers) return false;
  let shared = 0;
  for (const token of a.tokens) if (b.tokens.has(token)) shared += 1;
  const union = a.tokens.size + b.tokens.size - shared;
  return union > 0 && shared / union >= CROSS_SECTION_DUPLICATE_JACCARD;
}

/** Another section of the same document, as the cross-section comparison sees it. */
interface SectionReference {
  readonly sectionKey: string;
  /** The compiled template's title for `sectionKey` — what `duplicateOfTitle` carries. */
  readonly title: string;
  readonly forms: readonly MatchForm[];
}

/**
 * The `duplicate` annotations for `content` — the text a turn writes into one section — against
 * every OTHER section of the same document.
 *
 * A run is a maximal stretch of at least {@link CROSS_SECTION_DUPLICATE_MIN_RUN} CONSECUTIVE
 * eligible sentences of `content`, every one of which matches (see `sentencesMatch`) some sentence
 * of ONE other section. A one-word or empty sentence is not eligible and ends a run. Runs are found
 * greedily left to right: at each sentence the longest run any single section supports wins (ties
 * go to the section earliest in template order), it is flagged, and the scan resumes after it — so
 * runs never overlap.
 *
 * Offsets index `content`, and span the run's first sentence start to its last sentence end —
 * exactly the text, never the separator after it. Each annotation names the other section twice:
 * `duplicateOf` (its key) and `duplicateOfTitle` (its compiled title).
 */
function crossSectionDuplicates(content: string, references: readonly SectionReference[]): SectionAnnotationDto[] {
  const sentences = splitSentences(content);
  const forms = sentences.map((sentence) => (isEligibleSentence(sentence.text) ? matchForm(sentence.text) : null));
  const annotations: SectionAnnotationDto[] = [];

  let at = 0;
  while (at < sentences.length) {
    let best: { reference: SectionReference; length: number } | undefined;
    for (const reference of references) {
      let length = 0;
      for (;;) {
        const form = forms[at + length];
        if (!form || !reference.forms.some((candidate) => sentencesMatch(form, candidate))) break;
        length += 1;
      }
      if (length >= CROSS_SECTION_DUPLICATE_MIN_RUN && (!best || length > best.length)) best = { reference, length };
    }

    if (!best) {
      at += 1;
      continue;
    }
    annotations.push({
      kind: 'duplicate',
      start: sentences[at]!.start,
      end: sentences[at + best.length - 1]!.end,
      duplicateOf: best.reference.sectionKey,
      // The title as HOPE knows it, so a client that holds the section under another key (or under
      // a generic identity) can still name it rather than print a raw key.
      duplicateOfTitle: best.reference.title,
    });
    at += best.length;
  }

  return annotations;
}

/** One section of a FINISHED document, as {@link crossSectionDuplicateAnnotations} reads it. */
export interface DocumentSectionText {
  readonly sectionKey: string;
  /** What a `duplicate` naming this section carries as `duplicateOfTitle`. */
  readonly title: string;
  readonly content: string;
}

/**
 * TASK-1001 (wave 2, final note) — the cross-section `duplicate` annotations of a FINISHED document:
 * the detector a turn runs (`crossSectionDuplicates`, above), over text that will not change again.
 *
 * The live flags are computed per turn, against whatever the other sections held at that moment, so
 * they describe the note as it was being written. A note that has been finalised needs them computed
 * over its final text, and by THIS rule rather than a second copy of it — which is why this exists.
 *
 * Returns one list per input section, index-aligned, each exactly what `crossSectionDuplicates`
 * returns for it: offsets are section-LOCAL (they index that section's own `content`) and a list is
 * empty when nothing is flagged. Each section is compared with the sections BEFORE it in the order
 * given and never after, so a passage in two sections is flagged once, on the later copy, pointing
 * at the earlier — the outcome `applyTurn` gives one turn writing a paragraph into two sections. Two
 * entries sharing a `sectionKey` are one section and are never compared with each other, as
 * `applyTurn` never compares a section with itself.
 *
 * Pure: content is read for the comparison and never altered, reordered or dropped.
 */
export function crossSectionDuplicateAnnotations(sections: readonly DocumentSectionText[]): SectionAnnotationDto[][] {
  const forms = sections.map((section) => splitSentences(section.content).map((sentence) => matchForm(sentence.text)));

  return sections.map((section, index) => {
    const references: SectionReference[] = [];
    for (let at = 0; at < index; at += 1) {
      const other = sections[at]!;
      if (other.sectionKey === section.sectionKey) continue;
      references.push({ sectionKey: other.sectionKey, title: other.title, forms: forms[at]! });
    }
    return crossSectionDuplicates(section.content, references);
  });
}

// =================================================================================================
// TASK-1022 — "nothing stated" placeholders are not content
// =================================================================================================

/**
 * A live replay (gemma-4-e2b) answered a section the transcript had not reached with PROSE rather
 * than `null` — "No new instructions or orders were stated in the current transcript." — and the
 * fold appended it like any other addition. It then sat beside the real orders for the rest of the
 * consultation. The prompt already forbids it ("never a placeholder"); this is where it is enforced.
 *
 * Deliberately CONSERVATIVE, like `JSON_NULL_SENTINELS`: a sentence is a placeholder only when its
 * WHOLE normalised text matches one of these anchored patterns, and every pattern describes the
 * DOCUMENTATION ("not stated", "no orders", "… in the current transcript"), never the PATIENT. A
 * pertinent negative — "No chest pain reported", "No known drug allergies" — is a finding and does
 * not match; nor does a bare `None` / `Nil`, which is a legitimate clinical answer ("Allergies:
 * None"). A subject-bearing "X was not mentioned" matches ONLY with a transcript scope ("… in the
 * current transcript"), because without one "Fever not reported" can be read as a denial.
 */
const PLACEHOLDER_STATE_VERB = '(?:stated|mentioned|discussed|reported|documented|recorded|provided|given|specified|issued|noted|addressed|covered)';
const PLACEHOLDER_COPULA = '(?:(?:was|were|is|are|has been|have been) )?';
const PLACEHOLDER_TRANSCRIPT =
  '(?:in|during|from|by|for) (?:the |this )?(?:current |new |latest |partial )?(?:transcript|turn|segment|update)(?: so far)?';
const PLACEHOLDER_SCOPE = `(?: ${PLACEHOLDER_TRANSCRIPT})?(?: so far| yet)?`;
const PLACEHOLDER_QUALIFIER = '(?:(?:new|further|additional|other|specific|relevant) )*';
const PLACEHOLDER_DOC_NOUN = '(?:instructions?|orders?|information|details?|data|content|updates?)';

export const PLACEHOLDER_SENTENCE_PATTERNS: readonly RegExp[] = [
  // A bare marker: "N/A", "Not applicable", "None reported", "No data".
  new RegExp(`^(?:n/a|not applicable|not available|none ${PLACEHOLDER_STATE_VERB}|no data|no information|nothing to report)${PLACEHOLDER_SCOPE}$`),
  // "Not discussed", "Not mentioned in the current transcript".
  new RegExp(`^${PLACEHOLDER_COPULA}not (?:yet )?${PLACEHOLDER_STATE_VERB}${PLACEHOLDER_SCOPE}$`),
  // "No new instructions or orders were stated in the current transcript." — documentation nouns only.
  new RegExp(
    `^(?:there (?:was|were|is|are|has been|have been) )?no ${PLACEHOLDER_QUALIFIER}${PLACEHOLDER_DOC_NOUN}` +
      `(?:(?:,| or| and|/) ?${PLACEHOLDER_QUALIFIER}${PLACEHOLDER_DOC_NOUN})*(?: ${PLACEHOLDER_COPULA}${PLACEHOLDER_STATE_VERB})?${PLACEHOLDER_SCOPE}$`,
  ),
  // "Nothing new was reported in this turn."
  new RegExp(`^nothing(?: new| further| else)?(?: ${PLACEHOLDER_COPULA}${PLACEHOLDER_STATE_VERB})?${PLACEHOLDER_SCOPE}$`),
  // "Medications were not mentioned in the current transcript." — any subject, transcript scope REQUIRED.
  new RegExp(`^.{1,80}? ${PLACEHOLDER_COPULA}not ${PLACEHOLDER_STATE_VERB} ${PLACEHOLDER_TRANSCRIPT}$`),
  // "No chest pain was mentioned in the current transcript." — likewise, transcript scope REQUIRED.
  new RegExp(`^no .{1,80}? ${PLACEHOLDER_COPULA}${PLACEHOLDER_STATE_VERB} ${PLACEHOLDER_TRANSCRIPT}$`),
];

/** Comparison-only form: lowercased, bullet and wrapping brackets removed, trailing punctuation stripped. */
function placeholderForm(sentence: string): string {
  let form = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
  form = form.replace(/^[-*•–—]+\s*/, '');
  form = form.replace(/[.!;:…]+$/, '').trim();
  form = form.replace(/^[([]\s*(.*?)\s*[)\]]$/, '$1');
  return form.replace(/[.!;:…]+$/, '').trim();
}

function isPlaceholderSentence(sentence: string): boolean {
  const form = placeholderForm(sentence);
  // A "sentence" of punctuation alone (a stray `-`) carries nothing either.
  return form.length === 0 || PLACEHOLDER_SENTENCE_PATTERNS.some((pattern) => pattern.test(form));
}

/**
 * TASK-1022 — true when EVERY sentence of `text` is a "nothing stated" placeholder. Empty text is
 * `false`: it is nothing, not a placeholder.
 */
export function isNothingStatedPlaceholder(text: string): boolean {
  const sentences = splitSentences(text);
  return sentences.length > 0 && sentences.every((sentence) => isPlaceholderSentence(sentence.text));
}

/**
 * `text` without its placeholder sentences — every other sentence in its original text, order and
 * layout. Returns `text` itself (byte-identical) when there is nothing to remove, and `''` when
 * nothing else is left.
 */
function withoutPlaceholderSentences(text: string): string {
  const sentences = splitSentences(text);
  const kept = sentences.filter((sentence) => !isPlaceholderSentence(sentence.text));
  if (kept.length === sentences.length) return text;
  return kept
    .map((sentence) => `${sentence.text}${sentence.separator}`)
    .join('')
    .trim();
}

/** A turn with the placeholder sentences removed from every `addition` / `revision` (see `asContent`). */
function withoutPlaceholders(turn: ParsedTurn): ParsedTurn {
  const cleaned: Record<string, TurnSection> = {};
  for (const [key, section] of Object.entries(turn)) {
    const addition = section.addition === undefined ? undefined : withoutPlaceholderSentences(section.addition.trim());
    const revision = section.revision === undefined ? undefined : withoutPlaceholderSentences(section.revision.trim());
    const next: TurnSection = {
      ...(addition ? { addition } : {}),
      ...(revision ? { revision } : {}),
      ...(section.contradiction ? { contradiction: section.contradiction } : {}),
    };
    if (next.addition !== undefined || next.revision !== undefined) cleaned[key] = next;
  }
  return cleaned;
}

// =================================================================================================
// TASK-1022 — one turn, near-identical text in several sections: keep it in ONE
// =================================================================================================

/** The kind of section a template declares, read from its key AND title (keys vary per template). */
type RoutableSectionKind = 'plan' | 'follow-up' | 'orders';
/** The kind of text a turn wrote. */
type RoutableContentKind = 'plan' | 'orders';

function routableSectionKind(key: string, title: string): RoutableSectionKind | undefined {
  const words = ` ${`${key} ${title}`.toLowerCase().replace(/[_\-‐‑–]+/g, ' ')} `;
  if (/\bfollow ?up\b/.test(words)) return 'follow-up';
  if (/\b(?:instructions?|orders?)\b/.test(words)) return 'orders';
  // "Treatment History" / "Previous Plan" describe the past, not today's plan.
  if (/\b(?:plan|treatment|management)\b/.test(words) && !/\b(?:history|previous|prior|past)\b/.test(words)) return 'plan';
  return undefined;
}

const ROUTING_DOSE =
  /\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|iu|units?|milligrams?|micrograms?|grams?|millilit(?:re|er)s?|tablets?|tabs?|puffs?|drops?)\b/i;
const ROUTING_FREQUENCY =
  /\b(?:once|twice|thrice|three times|four times|daily|nightly|weekly|hourly|od|bd|bid|tds|tid|qid|qds|prn|at night|every (?:morning|evening|night|day|\d+ hours?))\b/i;
const ROUTING_PRESCRIBING = /\b(?:start|starting|prescrib(?:e|ed|ing)|initiat(?:e|ing)|continue|continuing)\b/i;
const ROUTING_ORDER =
  /\b(?:come back|return (?:in|after|on|if)|repeat|go to (?:the )?emergency|emergency department|follow[\s-]?up|review (?:in|after|on)|see (?:you|me) (?:in|after|on))\b/i;

/**
 * A new prescription or plan is a DOSE with a frequency or a prescribing verb ("starting",
 * "continue", "prescribe") — a dose is required, so "chest pain continues" or a lab value
 * ("142 mg/dL") is never mistaken for one. An order / instruction is return, repeat, emergency or
 * follow-up wording. Plan is checked first.
 */
function routableContentKind(text: string): RoutableContentKind | undefined {
  if (ROUTING_DOSE.test(text) && (ROUTING_FREQUENCY.test(text) || ROUTING_PRESCRIBING.test(text))) return 'plan';
  if (ROUTING_ORDER.test(text)) return 'orders';
  return undefined;
}

/**
 * The subject + verb a model puts in front of the same prescription line in different sections —
 * "Start X", "Patient is starting X", "I am starting X", "Continue X" — and the bullet marker before
 * it. Stripped for the ROUTING comparison only (never written, never used by the flag): the verb
 * says how the line was phrased, not what was prescribed. Narrow on purpose — the number multiset
 * and the Jaccard threshold still decide everything that follows it.
 */
const ROUTING_LEAD = /^(?:(?:the )?patient (?:is|was) |i am |i'm |we are |we're )?(?:start(?:ing|ed)?|continu(?:e|ing))\s+/i;
const ROUTING_BULLET = /^[\s\-*•–—]+/;

function routingText(sentence: string): string {
  const unbulleted = sentence.replace(ROUTING_BULLET, '');
  return unbulleted.replace(ROUTING_LEAD, '');
}

/**
 * The live replays' turns wrote the same prescription into several sections at once: run 1 put one
 * near-identical paragraph into `current_medications`, `additional_data` AND
 * `instructions_and_orders` and never into `treatment_plan`; run 4 wrote the plan's bullet lines
 * into `current_medications` and one of them, reworded ("Patient is starting …"), into
 * `additional_data`. This keeps each such SAME-TURN repeat in exactly one section, per SENTENCE /
 * bullet line (the whole additions differ, so grouping whole additions misses run 4):
 *
 * - candidates are the turn's `addition`s, and `revision`s on a section with no real content (a
 *   first write); a contradiction-backed revision is never touched. Each candidate is split with
 *   the dedup's own splitter, and only ELIGIBLE sentences (two words or more) take part;
 * - two sentences are the same by the cross-section flag's own measure (`sentencesMatch`: Jaccard
 *   >= {@link CROSS_SECTION_DUPLICATE_JACCARD}, identical number multiset) after the leading bullet
 *   and subject/verb (`routingText`) are stripped; a group must span at least two sections;
 * - a group is routed only when its text is a PLAN (→ a plan section) or an ORDER (→ a follow-up
 *   section, else an instructions/orders section). A member of the right kind wins; otherwise the
 *   template's first section of that kind receives it, appended after its own addition this turn;
 *   otherwise the first member in template order keeps it. The group's sentence is REMOVED from
 *   every other section's text, whose remaining sentences stay verbatim; a section left with
 *   nothing writes nothing;
 * - the kept variant loses no words: the one whose stripped form is longest. On a tie a member
 *   target keeps its OWN wording, and an outside target receives the longest raw variant;
 * - a group of any OTHER text keeps the TASK-1001 owner decision: written everywhere and FLAGGED.
 *
 * A no-op for a template with no plan / follow-up / orders section. Cross-TURN repeats are not
 * candidates at all: they keep the flag.
 */
function routeSameTurnRepeats(turn: ParsedTurn, compiled: CompiledDocumentTemplate, existing: ReadonlyMap<string, string>): ParsedTurn {
  const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));
  const kinds = new Map(compiled.sectionKeys.map((key) => [key, routableSectionKind(key, titles.get(key) ?? key)]));
  if (![...kinds.values()].some((kind) => kind !== undefined)) return turn;

  interface Candidate {
    readonly key: string;
    readonly field: 'addition' | 'revision';
    readonly sentences: readonly Sentence[];
  }
  interface Member {
    readonly candidate: number;
    readonly sentence: number;
    readonly form: MatchForm;
    /** Length of the stripped comparison text — what "loses no words" is measured on. */
    readonly weight: number;
  }
  const candidates: Candidate[] = [];
  const members: Member[] = [];
  for (const key of compiled.sectionKeys) {
    const section = turn[key];
    if (!section) continue;
    let field: Candidate['field'];
    let text: string | undefined;
    if (section.revision !== undefined) {
      const before = existing.get(key) ?? '';
      if (section.contradiction || (before.trim().length > 0 && !isNothingStatedPlaceholder(before))) continue;
      field = 'revision';
      text = section.revision;
    } else {
      field = 'addition';
      text = section.addition;
    }
    if (!text) continue;
    const sentences = splitSentences(text);
    const candidate = candidates.length;
    candidates.push({ key, field, sentences });
    for (const [index, sentence] of sentences.entries()) {
      if (!isEligibleSentence(sentence.text)) continue;
      const stripped = routingText(sentence.text);
      if (!isEligibleSentence(stripped)) continue;
      members.push({ candidate, sentence: index, form: matchForm(stripped), weight: normaliseForComparison(stripped).length });
    }
  }
  if (candidates.length < 2) return turn;

  // Connected components over the pairwise match, members kept in template-then-sentence order.
  const groupOf = members.map((_, index) => index);
  const root = (index: number): number => (groupOf[index] === index ? index : (groupOf[index] = root(groupOf[index]!)));
  for (let a = 0; a < members.length; a += 1) {
    for (let b = a + 1; b < members.length; b += 1) {
      if (members[a]!.candidate === members[b]!.candidate) continue;
      if (sentencesMatch(members[a]!.form, members[b]!.form)) groupOf[root(b)] = root(a);
    }
  }
  const groups = new Map<number, Member[]>();
  for (const [index, member] of members.entries()) {
    const group = groups.get(root(index)) ?? [];
    group.push(member);
    groups.set(root(index), group);
  }

  const textOf = (member: Member): string => candidates[member.candidate]!.sentences[member.sentence]!.text;
  const keyOf = (member: Member): string => candidates[member.candidate]!.key;
  /** Per candidate: sentence index → replacement text (a member target's kept variant) or null (removed). */
  const edits = candidates.map(() => new Map<number, string | null>());
  /** Per outside target: the kept variants it receives, with the separator that followed each. */
  const received = new Map<string, { text: string; separator: string }[]>();

  for (const group of groups.values()) {
    if (new Set(group.map(keyOf)).size < 2) continue;
    const longestRaw = group.reduce((longest, m) => (textOf(m).length > textOf(longest).length ? m : longest));
    const contentKind = routableContentKind(textOf(longestRaw));
    if (!contentKind) continue;

    const preferred: readonly RoutableSectionKind[] = contentKind === 'plan' ? ['plan'] : ['follow-up', 'orders'];
    const member = preferred.map((kind) => group.find((m) => kinds.get(keyOf(m)) === kind)).find(Boolean);
    const outsider = member
      ? undefined
      : preferred.map((kind) => compiled.sectionKeys.find((key) => kinds.get(key) === kind && turn[key]?.revision === undefined)).find(Boolean);
    const target = member ? keyOf(member) : (outsider ?? keyOf(group[0]!));
    const own = member ?? group.find((m) => keyOf(m) === target);

    const heaviest = Math.max(...group.map((m) => m.weight));
    const kept =
      own && own.weight === heaviest
        ? own
        : group.filter((m) => m.weight === heaviest).reduce((a, b) => (textOf(b).length > textOf(a).length ? b : a));

    for (const m of group) {
      if (keyOf(m) !== target) edits[m.candidate]!.set(m.sentence, null);
    }
    if (own) {
      if (kept !== own) edits[own.candidate]!.set(own.sentence, textOf(kept));
    } else {
      const separator = candidates[kept.candidate]!.sentences[kept.sentence]!.separator;
      const list = received.get(target) ?? [];
      list.push({ text: textOf(kept), separator });
      received.set(target, list);
    }
  }

  const next: Record<string, TurnSection> = { ...turn };
  for (const [index, candidate] of candidates.entries()) {
    const edit = edits[index]!;
    if (edit.size === 0) continue;
    const text = candidate.sentences
      .flatMap((sentence, at) => {
        const replacement = edit.get(at);
        if (replacement === null) return [];
        return [`${replacement ?? sentence.text}${sentence.separator}`];
      })
      .join('')
      .trim();
    if (text.length === 0) delete next[candidate.key];
    else next[candidate.key] = { ...turn[candidate.key], [candidate.field]: text };
  }
  for (const [target, list] of received) {
    // Re-joined in the authors' own layout; a variant that ended its source text gets a line break.
    const block = list
      .map(({ text, separator }, at) => (at === list.length - 1 ? text : `${text}${separator.length > 0 ? separator : '\n'}`))
      .join('')
      .trim();
    const own = next[target]?.addition;
    next[target] = { ...next[target], addition: own ? `${own}\n\n${block}` : block };
  }
  return next;
}

// =================================================================================================
// TASK-1022 (D-GROUND) — a CURRENT-visit section never takes a sentence only the reference supports
// =================================================================================================

/**
 * Which sections the grounding guard applies to, read from the key AND title like
 * `routableSectionKind` (keys vary per template). PRIOR wins: "Investigations (Previous vs Current)"
 * is a prior section, so the guard never touches it. A section matching neither list (Additional
 * Data, Presenting Complaints, Reports, Hospital Admissions) is left alone — the guard is
 * conservative by construction.
 */
const GROUNDING_PRIOR_SECTION = /\b(?:previous|last|prior|past|history)\b/;
const GROUNDING_CURRENT_SECTION = /\b(?:new complaints?|current|exam|examinations?|vitals?|treatment|plan|follow ?up|instructions?|orders?)\b/;
/** A current section that is ALSO a results section may carry the TEST RESULTS lines unprompted. */
const GROUNDING_RESULTS_SECTION = /\b(?:investigations?|results?|reports?|labs?|laboratory)\b/;

type GroundingSectionKind = 'current' | 'current-results';

function groundingSectionKind(key: string, title: string): GroundingSectionKind | undefined {
  const words = ` ${`${key} ${title}`.toLowerCase().replace(/[_\-‐‑–]+/g, ' ')} `;
  if (GROUNDING_PRIOR_SECTION.test(words)) return undefined;
  if (!GROUNDING_CURRENT_SECTION.test(words)) return undefined;
  return GROUNDING_RESULTS_SECTION.test(words) ? 'current-results' : 'current';
}

/**
 * Words that carry no clinical content: function words, and the provenance phrasing a model wraps
 * copied text in ("carried over from the earlier visit"). Excluded from BOTH support measures.
 */
const GROUNDING_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'the and are was were for with from that this these those have has had been being will would can could should not but ' +
    'his her hers she him they them their you your our ours its into onto over under also then than some any all per each ' +
    'other such very most more less which what when where who whom whose there here about after before during while ' +
    'today morning afternoon evening earlier later visit visits carried patient doctor clinician ref noted stated ' +
    'reported documented recorded mentioned'
  ).split(' '),
);

/**
 * Words too generic to show on their own that the transcript mentions the SAME fact (units,
 * frequencies, routine qualifiers). They still count toward reference support; they do not count as
 * transcript grounding, or "Metformin 500 milligrams twice daily" would ground the morning's
 * "Aspirin 81 milligrams daily was planned".
 */
const GROUNDING_GENERIC: ReadonlySet<string> = new Set(
  (
    'milligram milligrams microgram micrograms gram grams millilitre millilitres milliliter milliliters tablet tablets ' +
    'daily twice once thrice times mouth oral dose doses week weeks day days month months hour hours ' +
    'plan planned planning start started starting continue continued continuing include included including'
  ).split(' '),
);

/** Reference support threshold: the share of a sentence's content tokens the reference carries. */
const GROUNDING_REFERENCE_COVERAGE = 0.75;

/** A text's content tokens, lower-cased: every number, and every word of 3+ letters not a stopword. */
function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(MATCH_TOKEN) ?? []).filter(
    (token) => NUMBER_TOKEN.test(token) || (token.length >= 3 && !GROUNDING_STOPWORDS.has(token)),
  );
}

interface GroundingSource {
  readonly tokens: ReadonlySet<string>;
  readonly forms: readonly MatchForm[];
}

function groundingSource(text: string): GroundingSource {
  return {
    tokens: new Set(contentTokens(text)),
    forms: splitSentences(text)
      .filter((sentence) => isEligibleSentence(sentence.text))
      .map((sentence) => matchForm(sentence.text)),
  };
}

/** Grounded in the transcript: a shared number, or a shared distinctive (non-generic) word. */
function groundedInTranscript(tokens: readonly string[], transcript: ReadonlySet<string>): boolean {
  return tokens.some((token) => transcript.has(token) && (NUMBER_TOKEN.test(token) || !GROUNDING_GENERIC.has(token)));
}

/**
 * Supported by a reference text: the same sentence by the cross-section flag's own measure, or a
 * sentence whose content tokens the reference carries at {@link GROUNDING_REFERENCE_COVERAGE} with
 * EVERY number present — so a changed value is never "supported" by the old one.
 */
function supportedBy(sentence: string, tokens: readonly string[], source: GroundingSource): boolean {
  const form = matchForm(sentence);
  if (source.forms.some((candidate) => sentencesMatch(form, candidate))) return true;
  if (tokens.length === 0) return false;
  if (tokens.some((token) => NUMBER_TOKEN.test(token) && !source.tokens.has(token))) return false;
  const covered = tokens.filter((token) => source.tokens.has(token)).length;
  return covered / tokens.length >= GROUNDING_REFERENCE_COVERAGE;
}

interface GroundedText {
  readonly text: string;
  readonly dropped: number;
}

/**
 * `text` without the sentences only the reference supports. A sentence is DROPPED only when all of:
 * it is eligible (two words or more — the dedup's own rule); it shares no number and no distinctive
 * word with the transcript; and a reference text supports it. Everything else is kept verbatim, in
 * its original order and layout. Returns `text` itself when nothing is dropped.
 */
function withoutReferenceOnlySentences(text: string, references: readonly GroundingSource[], transcript: ReadonlySet<string>): GroundedText {
  const sentences = splitSentences(text);
  let dropped = 0;
  const kept = sentences.filter((sentence) => {
    if (!isEligibleSentence(sentence.text)) return true;
    const tokens = contentTokens(sentence.text);
    if (tokens.length === 0 || groundedInTranscript(tokens, transcript)) return true;
    if (!references.some((reference) => supportedBy(sentence.text, tokens, reference))) return true;
    dropped += 1;
    return false;
  });
  if (dropped === 0) return { text, dropped: 0 };
  return {
    text: kept
      .map((sentence) => `${sentence.text}${sentence.separator}`)
      .join('')
      .trim(),
    dropped,
  };
}

/**
 * Apply the grounding guard to a turn. A no-op (the SAME turn, count 0) without reference text. This
 * is a GROUNDING rule, not a duplicate rule: the TASK-1001 cross-section "flag, never drop" rule is
 * unchanged and still runs on whatever survives here.
 */
function withoutReferenceOnly(
  turn: ParsedTurn,
  compiled: CompiledDocumentTemplate,
  grounding: TurnGrounding,
): { readonly turn: ParsedTurn; readonly dropped: number } {
  const prequel = grounding.sameDayPrequel?.trim() ?? '';
  const results = grounding.testResults?.trim() ?? '';
  if (!prequel && !results) return { turn, dropped: 0 };

  const prequelSource = prequel ? groundingSource(prequel) : undefined;
  const resultsSource = results ? groundingSource(results) : undefined;
  const transcript = new Set(contentTokens(grounding.transcript));
  const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));

  let dropped = 0;
  const next: Record<string, TurnSection> = {};
  for (const [key, section] of Object.entries(turn)) {
    const kind = groundingSectionKind(key, titles.get(key) ?? key);
    if (!kind) {
      next[key] = section;
      continue;
    }
    // A results section may carry the TEST RESULTS lines; only the earlier visit is reference there.
    const references = [prequelSource, kind === 'current' ? resultsSource : undefined].filter(
      (source): source is GroundingSource => source !== undefined,
    );
    if (references.length === 0) {
      next[key] = section;
      continue;
    }
    const addition = section.addition === undefined ? undefined : withoutReferenceOnlySentences(section.addition, references, transcript);
    const revision = section.revision === undefined ? undefined : withoutReferenceOnlySentences(section.revision, references, transcript);
    dropped += (addition?.dropped ?? 0) + (revision?.dropped ?? 0);
    const cleaned: TurnSection = {
      ...(addition?.text ? { addition: addition.text } : {}),
      ...(revision?.text ? { revision: revision.text } : {}),
      ...(section.contradiction && revision?.text ? { contradiction: section.contradiction } : {}),
    };
    if (cleaned.addition !== undefined || cleaned.revision !== undefined) next[key] = cleaned;
  }
  return { turn: next, dropped };
}

/**
 * Fold a turn onto the prior note.
 *
 * Returns the note after the turn, the per-section writes it implies, and anything refused. The
 * caller persists the writes and publishes the sections; nothing here touches the store or the
 * wire, which is what makes the rules above testable without a database.
 */
export function applyTurn(
  prior: readonly LiveSummarySectionDto[],
  rawTurn: ParsedTurn,
  compiled: CompiledDocumentTemplate,
  grounding?: TurnGrounding,
): AppliedTurn {
  const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));
  const existing = priorByKey(prior, compiled);
  // TASK-1022 — placeholders out first (a caller may build a turn without `parseTurnJson`), then
  // same-turn repeats routed to one section. Both are pure rewrites of the TURN; the fold below is
  // unchanged apart from the placeholder-only cleanup.
  const routed = routeSameTurnRepeats(withoutPlaceholders(rawTurn), compiled, existing);
  // TASK-1022 (D-GROUND) — then the grounding guard, AFTER routing, because it judges the section a
  // sentence finally lands in. Only when the caller supplied what the turn may be grounded in.
  const grounded = grounding ? withoutReferenceOnly(routed, compiled, grounding) : undefined;
  const turn = grounded?.turn ?? routed;

  const sections: LiveSummarySectionDto[] = [];
  const writes: TurnSectionWrite[] = [];
  const refusals: TurnRefusal[] = [];
  let droppedSentenceCount = 0;

  // TASK-1001 (wave 2) — what every section holds AT THIS POINT of the fold, for the cross-section
  // flag: its stored text until the fold reaches it, its post-turn text from then on. A write is
  // therefore compared against every other section's stored text AND against what this turn wrote
  // EARLIER in template order — so a paragraph written into two sections in one turn is flagged on
  // the LATER one only, pointing at the earlier one, and never on both.
  const current = new Map(existing);
  const formCache = new Map<string, MatchForm[]>();
  const referencesFor = (sectionKey: string): SectionReference[] =>
    compiled.sectionKeys
      .filter((key) => key !== sectionKey)
      .map((key) => {
        let forms = formCache.get(key);
        if (!forms) {
          forms = splitSentences(current.get(key) ?? '').map((sentence) => matchForm(sentence.text));
          formCache.set(key, forms);
        }
        return { sectionKey: key, title: titles.get(key) ?? key, forms };
      });
  let crossSectionDuplicateCount = 0;
  /**
   * Attach the flag to a write that APPENDS or FIRST writes a section. It returns the SAME write
   * when nothing is flagged, and otherwise the same write plus `duplicates` — `content` is never
   * read for anything but the comparison, so the write is byte-for-byte what it was without it.
   */
  const flagged = (write: TurnSectionWrite): TurnSectionWrite => {
    const duplicates = crossSectionDuplicates(write.content, referencesFor(write.sectionKey));
    crossSectionDuplicateCount += duplicates.length;
    return duplicates.length > 0 ? { ...write, duplicates } : write;
  };

  for (const [idx, sectionKey] of compiled.sectionKeys.entries()) {
    const title = titles.get(sectionKey) ?? sectionKey;
    const before = existing.get(sectionKey) ?? '';
    const contribution = turn[sectionKey];
    let after = before;
    // TASK-1022 — a body that is ONLY an older turn's "nothing stated" placeholder is not content:
    // real text REPLACES it (a deterministic cleanup, not a model revision, so no contradiction is
    // needed) instead of being appended beside it. A clinician-confirmed body is still protected —
    // the store refuses a machine `replace` on it.
    const placeholderOnly = isNothingStatedPlaceholder(before);
    const base = placeholderOnly ? '' : before;

    // `revision` wins over `addition` when a turn supplies both: a contradiction is the stronger
    // claim about the same text, and applying the append too would re-add content the revision has
    // just reworded.
    if (contribution?.revision !== undefined) {
      const hadContent = base.trim().length > 0;
      if (!hadContent) {
        // Nothing to contradict — on an empty section a "revision" is just the first content.
        after = contribution.revision.trim();
        writes.push(flagged({ sectionKey, title, idx, mode: 'replace', content: after }));
      } else if (contribution.contradiction) {
        after = contribution.revision.trim();
        writes.push({ sectionKey, title, idx, mode: 'replace', content: after, contradiction: { reason: contribution.contradiction } });
      } else {
        // THE GUARD. The prior text stands and the rewrite is dropped — an unjustified replace is
        // the defect this contract exists to prevent.
        refusals.push({ sectionKey, reason: 'revision-without-contradiction' });
      }
    } else if (contribution?.addition) {
      const addition = contribution.addition.trim();
      // A model restating something it already wrote must not duplicate it. Checked on the stored
      // text rather than trusted from the instruction, because "never repeat" is advice and this
      // is the only place it can be enforced. TASK-1001: per SENTENCE, because a restatement that
      // merges, respaces or reorders what is already written is not a substring of it.
      if (addition.length > 0) {
        const novel = withoutSentencesAlreadyPresent(base, addition);
        droppedSentenceCount += novel.dropped;

        if (novel.text.length > 0) {
          after = base.trim().length > 0 ? `${base.trim()}\n\n${novel.text}` : novel.text;
          writes.push(flagged({ sectionKey, title, idx, mode: placeholderOnly ? 'replace' : 'append', content: novel.text }));
        } else {
          // Nothing in the addition was new. No write at all — the section is byte-stable — and the
          // refusal is what makes the pressure countable instead of invisible.
          refusals.push({ sectionKey, reason: 'addition-already-present' });
        }
      }
    }

    sections.push({ title, content: after });
    if (after !== before) {
      current.set(sectionKey, after);
      formCache.delete(sectionKey);
    }
  }

  return {
    sections,
    writes,
    refusals,
    droppedSentenceCount,
    crossSectionDuplicateCount,
    ...(grounded ? { ungroundedSentenceCount: grounded.dropped } : {}),
  };
}

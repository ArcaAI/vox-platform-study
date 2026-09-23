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
 * Deliberately NARROW — only a value whose ENTIRE trimmed text is one of these. `N/A`, `None` and
 * `Nil` are legitimate clinical shorthand; discarding those would lose real content, which is a
 * worse defect than the one this prevents.
 */
const JSON_NULL_SENTINELS: ReadonlySet<string> = new Set(['null', 'undefined']);

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return JSON_NULL_SENTINELS.has(trimmed.toLowerCase()) ? undefined : trimmed;
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
      ...(asText(entry.addition) ? { addition: asText(entry.addition)! } : {}),
      ...(asText(entry.revision) ? { revision: asText(entry.revision)! } : {}),
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

  return { text: kept.map((sentence) => `${sentence.text}${sentence.separator}`).join('').trim(), dropped };
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

/**
 * Fold a turn onto the prior note.
 *
 * Returns the note after the turn, the per-section writes it implies, and anything refused. The
 * caller persists the writes and publishes the sections; nothing here touches the store or the
 * wire, which is what makes the rules above testable without a database.
 */
export function applyTurn(prior: readonly LiveSummarySectionDto[], turn: ParsedTurn, compiled: CompiledDocumentTemplate): AppliedTurn {
  const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));
  const existing = priorByKey(prior, compiled);

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

    // `revision` wins over `addition` when a turn supplies both: a contradiction is the stronger
    // claim about the same text, and applying the append too would re-add content the revision has
    // just reworded.
    if (contribution?.revision !== undefined) {
      const hadContent = before.trim().length > 0;
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
        const novel = withoutSentencesAlreadyPresent(before, addition);
        droppedSentenceCount += novel.dropped;

        if (novel.text.length > 0) {
          after = before.trim().length > 0 ? `${before.trim()}\n\n${novel.text}` : novel.text;
          writes.push(flagged({ sectionKey, title, idx, mode: 'append', content: novel.text }));
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

  return { sections, writes, refusals, droppedSentenceCount, crossSectionDuplicateCount };
}

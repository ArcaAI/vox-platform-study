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
 */
import type { CompiledDocumentTemplate, CompiledResponseFormat } from '../../../document-template/document-template-compiler';
import type { LiveSummarySectionDto } from '../dto';

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
}

export type TurnRefusalReason = 'revision-without-contradiction';

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
export function wholeDocumentAsTurn(
  parsed: readonly LiveSummarySectionDto[],
  compiled: CompiledDocumentTemplate,
): AppliedTurn {
  // The parsed list is passed through VERBATIM rather than re-keyed onto `sectionKeys`. The prose
  // parser has its own fallback — a single `Running Summary` section carrying the whole output when
  // no heading matched — and re-keying would silently discard it, publishing an empty note for a
  // generation that actually said something. Positional key derivation (with a title-slug fallback)
  // is exactly what `publishSectionPatches` did before this ticket, so the degrade is faithful.
  const writes: TurnSectionWrite[] = [];

  for (const [idx, section] of parsed.entries()) {
    const content = section.content ?? '';
    if (content.trim().length === 0) continue;
    const sectionKey = compiled.sectionKeys[idx] ?? section.title.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    writes.push({ sectionKey, title: section.title, idx, mode: 'replace', content });
  }

  return { sections: [...parsed], writes, refusals: [] };
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
        writes.push({ sectionKey, title, idx, mode: 'replace', content: after });
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
      // is the only place it can be enforced.
      if (addition.length > 0 && !before.includes(addition)) {
        after = before.trim().length > 0 ? `${before.trim()}\n\n${addition}` : addition;
        writes.push({ sectionKey, title, idx, mode: 'append', content: addition });
      }
    }

    sections.push({ title, content: after });
  }

  return { sections, writes, refusals };
}

/**
 * TASK-1001 wave 4 (owner decisions D-1/D-2, 2026-09-23) — the live note's OUTPUT check.
 *
 * Every instruction the live lane sends says the note is English, and on `hope-v2-dev` the model
 * (`gemma-4-e2b-it-qat`, ~16k-token prompts) still occasionally copied a code-switched line from
 * the transcript into a section verbatim — consultation `01a0cd63`, Plan section, 147 Malayalam
 * characters. Instructions are advice to a model; this is the check on what it actually wrote.
 *
 * The rule is deliberately narrow: a section write this turn produced that carries Indic-script
 * characters gets ONE translate-only retry. A translation is accepted only when it is non-empty and
 * itself free of Indic script; otherwise the model's original text stands and the turn counts it as
 * unresolved (D-2 — clinical text is never dropped to make a note look English).
 *
 * Pure apart from the injected `translate`: the caller owns the model call, the quota and the
 * tenant headers, and decides whether the check applies at all (D-1).
 */
import type { LiveSummarySectionDto } from '../dto';
import type { TurnSectionWrite } from './turn-contract';

/**
 * Devanagari through Sinhala (U+0900–U+0DFF): Malayalam, Tamil, Telugu, Kannada, Hindi and the
 * other scripts a code-switched Indian consultation can leak. A note written in English carries
 * none of them; drug names, numbers and English words spoken inside a Malayalam sentence are Latin.
 */
const INDIC_SCRIPT = /[ऀ-෿]/g;

export function countIndicScript(text: string): number {
  return text ? (text.match(INDIC_SCRIPT) ?? []).length : 0;
}

export interface ScriptRepairOutcome {
  readonly sections: LiveSummarySectionDto[];
  readonly writes: TurnSectionWrite[];
  /** Writes whose Indic-script text was replaced by an accepted translation. */
  readonly repaired: number;
  /** Writes that still carry Indic script — the retry failed, came back empty, or leaked again. */
  readonly unresolved: number;
}

/** The section a write lands on: its template ordinal when the title agrees, else the title. */
function sectionIndexFor(sections: readonly LiveSummarySectionDto[], write: TurnSectionWrite): number {
  if (sections[write.idx]?.title === write.title) return write.idx;
  return sections.findIndex((section) => section.title === write.title);
}

/**
 * The section body after swapping `from` for `to`. A replace write IS the body; an append write is
 * the tail `applyTurn` just added, so its LAST occurrence is the one this turn wrote. `null` when
 * the body no longer contains the write (never expected — the caller then keeps the original).
 */
function spliced(body: string, write: TurnSectionWrite, to: string): string | null {
  if (write.mode === 'replace') return to;
  const at = body.lastIndexOf(write.content);
  return at < 0 ? null : body.slice(0, at) + to + body.slice(at + write.content.length);
}

export async function repairTurnScript(
  input: { readonly sections: LiveSummarySectionDto[]; readonly writes: TurnSectionWrite[] },
  translate: (text: string) => Promise<string | null | undefined>,
): Promise<ScriptRepairOutcome> {
  const { sections, writes } = input;
  if (!writes.some((write) => countIndicScript(write.content) > 0)) return { sections, writes, repaired: 0, unresolved: 0 };

  const nextSections = [...sections];
  const nextWrites: TurnSectionWrite[] = [];
  let repaired = 0;
  let unresolved = 0;

  for (const write of writes) {
    if (countIndicScript(write.content) === 0) {
      nextWrites.push(write);
      continue;
    }
    const translated = (await translate(write.content).catch(() => null))?.trim() ?? '';
    const at = sectionIndexFor(nextSections, write);
    const body = translated && countIndicScript(translated) === 0 && at >= 0 ? spliced(nextSections[at].content, write, translated) : null;
    if (body === null) {
      unresolved += 1;
      nextWrites.push(write);
      continue;
    }
    nextSections[at] = { ...nextSections[at], content: body };
    // `duplicates` offsets index the text they were computed on; after a translation they point at
    // nothing, and a flag on the wrong span is worse than no flag.
    const { duplicates: _stale, ...rest } = write;
    nextWrites.push({ ...rest, content: translated });
    repaired += 1;
  }

  return { sections: nextSections, writes: nextWrites, repaired, unresolved };
}

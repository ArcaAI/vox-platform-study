import { describe, expect, it, vi } from 'vitest';

import type { LiveSummarySectionDto } from '../../dto';
import { countIndicScript, repairTurnScript } from '../script-guard';
import type { TurnSectionWrite } from '../turn-contract';

// TASK-1001 wave 4 (D-1/D-2) — the live note's output check. A small model occasionally copies a
// code-switched line from the transcript into a section verbatim; the note must stay English.
const LEAKED = 'Folic acid 5mg ഓട് follow ചെയ്യണം.';
const TRANSLATED = 'Folic acid 5mg to be continued.';

const write = (over: Partial<TurnSectionWrite>): TurnSectionWrite => ({
  sectionKey: 'plan_of_care',
  title: 'Plan of Care',
  idx: 1,
  mode: 'append',
  content: LEAKED,
  ...over,
});

describe('countIndicScript', () => {
  it('counts Malayalam and other Indic-script characters, and nothing in Latin text', () => {
    expect(countIndicScript('ferric carboxymaltose 1000 mg')).toBe(0);
    expect(countIndicScript('ഓട്')).toBe(3);
    expect(countIndicScript('नमस्ते')).toBeGreaterThan(0);
    expect(countIndicScript('')).toBe(0);
  });
});

describe('repairTurnScript', () => {
  const prior = 'Intravenous ferric carboxymaltose 1000 mg single dose.';

  it('translates an appended leak once and splices the translation into the section body', async () => {
    const sections: LiveSummarySectionDto[] = [
      { title: 'Diagnosis', content: 'Iron deficiency anaemia.' },
      { title: 'Plan of Care', content: `${prior}\n${LEAKED}` },
    ];
    const translate = vi.fn().mockResolvedValue(TRANSLATED);

    const out = await repairTurnScript({ sections, writes: [write({})] }, translate);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith(LEAKED);
    expect(out.repaired).toBe(1);
    expect(out.unresolved).toBe(0);
    expect(out.writes[0].content).toBe(TRANSLATED);
    expect(out.sections[1].content).toBe(`${prior}\n${TRANSLATED}`);
    expect(out.sections[0]).toBe(sections[0]);
  });

  it('replaces the whole body for a replace write', async () => {
    const sections: LiveSummarySectionDto[] = [
      { title: 'Diagnosis', content: '' },
      { title: 'Plan of Care', content: LEAKED },
    ];
    const out = await repairTurnScript({ sections, writes: [write({ mode: 'replace' })] }, async () => TRANSLATED);
    expect(out.sections[1].content).toBe(TRANSLATED);
    expect(out.writes[0]).toMatchObject({ mode: 'replace', content: TRANSLATED });
  });

  it('drops a repaired write’s duplicate annotations — their offsets indexed the untranslated text', async () => {
    const sections: LiveSummarySectionDto[] = [
      { title: 'Diagnosis', content: '' },
      { title: 'Plan of Care', content: LEAKED },
    ];
    const flagged = write({ mode: 'replace', duplicates: [{ kind: 'duplicate', start: 0, end: 5 } as never] });
    const out = await repairTurnScript({ sections, writes: [flagged] }, async () => TRANSLATED);
    expect(out.writes[0].duplicates).toBeUndefined();
  });

  it('keeps the original text and counts it unresolved when the retry still carries Indic script (D-2)', async () => {
    const sections: LiveSummarySectionDto[] = [
      { title: 'Diagnosis', content: '' },
      { title: 'Plan of Care', content: LEAKED },
    ];
    const out = await repairTurnScript({ sections, writes: [write({ mode: 'replace' })] }, async () => 'still ഓട്');
    expect(out.repaired).toBe(0);
    expect(out.unresolved).toBe(1);
    expect(out.writes[0].content).toBe(LEAKED);
    expect(out.sections[1].content).toBe(LEAKED);
  });

  it('keeps the original when the translate call fails or answers empty', async () => {
    const sections: LiveSummarySectionDto[] = [
      { title: 'Diagnosis', content: '' },
      { title: 'Plan of Care', content: LEAKED },
    ];
    const failed = await repairTurnScript({ sections, writes: [write({ mode: 'replace' })] }, async () => {
      throw new Error('text down');
    });
    expect(failed).toMatchObject({ repaired: 0, unresolved: 1 });
    const empty = await repairTurnScript({ sections, writes: [write({ mode: 'replace' })] }, async () => '   ');
    expect(empty).toMatchObject({ repaired: 0, unresolved: 1 });
  });

  it('never calls the model for a clean turn and returns the inputs untouched', async () => {
    const sections: LiveSummarySectionDto[] = [{ title: 'Plan of Care', content: prior }];
    const writes = [write({ idx: 0, content: prior, mode: 'replace' })];
    const translate = vi.fn();
    const out = await repairTurnScript({ sections, writes }, translate);
    expect(translate).not.toHaveBeenCalled();
    expect(out).toEqual({ sections, writes, repaired: 0, unresolved: 0 });
  });
});

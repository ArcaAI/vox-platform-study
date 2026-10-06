/**
 * TASK-1047 (L2 hand-overs #3/#4) — the governed note plan: the system callback hands the composer
 * the assembly's governance (so each planned call can carry FC-4 `systemGovernance`), and the plan's
 * background carries the doctor's style reference (the static `dna-style` contract part points at it).
 */
import { describe, expect, it } from 'vitest';
import { noteComposedSystem, styleReferenceBackground } from '../note-plan-governance';

describe('noteComposedSystem', () => {
  it('returns the system prompt together with its governance', () => {
    const governance = { pieces: [{ kind: 'PLATFORM' as const, key: 'platform-rules@1', digest: 'a'.repeat(64) }], composedDigest: 'b'.repeat(64) };
    expect(noteComposedSystem({ systemPrompt: 'SYSTEM', governance })).toEqual({ system: 'SYSTEM', governance });
  });

  it("carries the assembly's platform pieces so the note composer can register them (V7)", () => {
    const platformPieces = [
      { kind: 'CONTRACT' as const, sourceType: 'PLATFORM' as const, sourceId: null, sourceKey: 'note-contract', text: 'Return JSON.' },
    ];
    expect(noteComposedSystem({ systemPrompt: 'SYSTEM', governance: null, platformPieces })).toEqual({
      system: 'SYSTEM',
      governance: null,
      platformPieces,
    });
  });

  it('absent governance is null (the plan call then carries none and apps/text screens it)', () => {
    expect(noteComposedSystem({ systemPrompt: 'SYSTEM' })).toEqual({ system: 'SYSTEM', governance: null });
  });
});

describe('styleReferenceBackground', () => {
  it('a style reference becomes one background entry keyed style_reference', () => {
    expect(styleReferenceBackground('Write tersely.')).toEqual([{ key: 'style_reference', label: 'Style reference', text: 'Write tersely.' }]);
  });

  it('no (or blank) style reference adds nothing', () => {
    expect(styleReferenceBackground(null)).toEqual([]);
    expect(styleReferenceBackground('  ')).toEqual([]);
  });
});

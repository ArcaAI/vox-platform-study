/**
 * Lane N — IMPORTANT FINDINGS on the realtime lane.
 *
 * Verdict on the owner's third acceptance item was blunt: *"important information
 * highlighted — DOES NOT EXIST. Entities reach the client re-anchored into the note so the UI
 * *can* highlight them, but there is no red-flag / critical-value / allergy-alert / severity layer
 * anywhere."* The owner's answer to "what makes information important?" was not a layer — it was a
 * configuration contract, so what these tests hold the code to is a configuration property:
 *
 *   - the node's SOURCE is the transcript, so a finding is always something that was SAID;
 *   - its INSTRUCTION comes from the node's bound template, so nothing here decides what matters;
 *   - its OUTPUT rides the highlight path that already exists, rather than a second one;
 *   - and a finding stays DISTINGUISHABLE from an NER entity all the way to the section patch,
 *     because "a detector recognised this" and "the tenant said this matters" are two claims.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_MAX_FINDINGS, parseImportantFindings } from '../parse-findings';
import { reanchorAnnotations } from '../reanchor-annotations';

const KEY = 'agent.important_findings';

const capabilities = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities =>
  ({
    transcribe: vi.fn().mockResolvedValue({ transcript: 'raw transcript', pipelineId: null }),
    generateDocument: vi.fn().mockResolvedValue({ text: 'note', sections: [], stats: null, repaired: false }),
    extractEntities: vi.fn().mockResolvedValue({ entities: [], vitals: undefined }),
    proposeCorrections: vi.fn().mockResolvedValue({ proposals: [], textSha256: '', rejectedProposals: 0 }),
    extractFindings: vi.fn().mockResolvedValue({ findings: [{ text: 'penicillin allergy', type: 'allergy' }] }),
    ...over,
  }) as RealtimeCapabilities;

const ctx = (bound: Record<string, unknown>, caps = capabilities(), config: Record<string, unknown> = {}) => ({
  bound,
  config,
  tenantId: 'tenant-1',
  consultationId: 'consultation-1',
  capabilities: caps,
});

describe('parsing the model reply — never fabricate, never anchor to nothing', () => {
  it('keeps the tenant’s OWN label verbatim, and validates it against no list', () => {
    const parsed = parseImportantFindings(JSON.stringify({ findings: [{ text: 'penicillin', type: 'whatever-the-tenant-called-it' }] }));
    expect(parsed).toEqual([{ text: 'penicillin', type: 'whatever-the-tenant-called-it' }]);
  });

  it('drops a row with no surface form — there would be nothing to anchor a highlight to', () => {
    expect(parseImportantFindings(JSON.stringify({ findings: [{ type: 'allergy' }, { text: '   ', type: 'allergy' }] }))).toEqual([]);
  });

  it('drops a row with no label rather than inventing one', () => {
    // Supplying a default label would be this module answering the question the owner assigned to
    // the tenant admin.
    expect(parseImportantFindings(JSON.stringify({ findings: [{ text: 'penicillin' }] }))).toEqual([]);
  });

  it('DISCARDS the model’s offsets — only the note-grounding pass may set start/end', () => {
    const [finding] = parseImportantFindings(JSON.stringify({ findings: [{ text: 'penicillin', type: 'allergy', start: 900, end: 910 }] }));
    // The model's numbers index whatever it thinks it read; the client's highlight offsets index
    // the rendered note. Carrying them through would silently mis-highlight clinical text.
    expect(finding.start).toBeUndefined();
    expect(finding.end).toBeUndefined();
  });

  it('keeps a confidence only when it is a real 0..1 number', () => {
    const parsed = parseImportantFindings(
      JSON.stringify({ findings: [{ text: 'a', type: 't', confidence: 0.8 }, { text: 'b', type: 't', confidence: 'high' }, { text: 'c', type: 't', confidence: 4 }] }),
    );
    expect(parsed).toEqual([{ text: 'a', type: 't', confidence: 0.8 }, { text: 'b', type: 't' }, { text: 'c', type: 't' }]);
  });

  it('returns an EMPTY list when nothing parses — a guessed finding is a clinical claim', () => {
    expect(parseImportantFindings('the model was chatty today')).toEqual([]);
    expect(parseImportantFindings(JSON.stringify({ findings: 'not a list' }))).toEqual([]);
  });

  it('tolerates a fenced or preambled reply, because engines add prose', () => {
    expect(parseImportantFindings('Sure!\n```json\n{"findings":[{"text":"x","type":"y"}]}\n```')).toEqual([{ text: 'x', type: 'y' }]);
  });

  it('caps output — a BOUNDED-OUTPUT guard, which is not the same as a ranking policy', () => {
    const many = { findings: Array.from({ length: 40 }, (_, i) => ({ text: `f${i}`, type: 't' })) };
    expect(parseImportantFindings(JSON.stringify(many)).length).toBe(DEFAULT_MAX_FINDINGS);
    expect(parseImportantFindings(JSON.stringify(many), 3).length).toBe(3);
  });
});

describe('a finding stays DISTINGUISHABLE from an NER entity all the way to the section patch', () => {
  const sections = [
    { title: 'Subjective', content: 'Reports a penicillin allergy.' },
    { title: 'Plan', content: 'Start aspirin 75mg.' },
  ];
  const document = 'Reports a penicillin allergy.\n\nStart aspirin 75mg.';

  it('annotates findings under their own `finding` kind, section-locally', () => {
    const perSection = reanchorAnnotations(
      sections as never,
      document,
      [{ text: 'aspirin', type: 'MEDICATION', start: 37, end: 44 }] as never,
      undefined,
      [{ text: 'penicillin allergy', type: 'allergy', start: 10, end: 28 }] as never,
    );
    expect(perSection[0]).toEqual([{ kind: 'finding', start: 10, end: 28, type: 'allergy' }]);
    expect(perSection[1]).toEqual([{ kind: 'entity', start: 6, end: 13, type: 'MEDICATION' }]);
  });

  it('is ABSENT when no findings node ran — every pre-Lane-N caller is byte-identical', () => {
    const perSection = reanchorAnnotations(sections as never, document, [] as never, undefined);
    expect(perSection.flat()).toEqual([]);
  });
});

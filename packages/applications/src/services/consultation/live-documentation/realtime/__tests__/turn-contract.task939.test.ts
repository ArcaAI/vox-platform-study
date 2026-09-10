/**
 * TASK-939 OD-2(a) — the TURN contract: a partial-summary turn emits what it ADDS, never the
 * document it already wrote.
 *
 * ## Why this is a contract and not a prompt
 *
 * Before this module, "keep the prior content" was a sentence in a prompt. The model was handed an
 * unlabelled concatenation of the note's sections and a schema demanding every section's full
 * body, so re-deriving and re-emitting the whole document was the only thing it COULD do — and the
 * seeded template told it to. Every turn therefore rewrote text the clinician had already read.
 *
 * Here, prior text is not re-emittable: a turn says `addition` (text to append) and, only where the
 * transcript CONTRADICTS what is written, `revision` + `contradiction`. Byte-stability stops being
 * a request and becomes a property of the shape — and a turn's output cost becomes proportional to
 * what was actually said.
 *
 * ## The guard that makes it hold
 *
 * `revision` is a full section rewrite, so an unguarded one is the old behaviour wearing a new
 * field name. A `revision` with no `contradiction` is REFUSED and the prior text stands. That is
 * the same shape as the store's existing `deletion-without-contradiction` rule, for the same
 * reason: a model silently replacing what it said two turns ago is indistinguishable, to a reader,
 * from the clinician never having said the first thing.
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, buildTurnResponseFormat, parseTurnJson, wholeDocumentAsTurn } from '../turn-contract';

const compiled = compileDocumentTemplate({
  title: 'SOAP Note',
  sections: [
    { key: 'subjective', title: 'Subjective', form: 'PROSE', required: true },
    { key: 'objective', title: 'Objective', form: 'PROSE' },
    { key: 'assessment', title: 'Assessment', form: 'PROSE' },
    { key: 'plan', title: 'Plan', form: 'PROSE' },
  ],
} as never);

const prior = [
  { title: 'Subjective', content: 'Cough for three days.' },
  { title: 'Objective', content: 'Temp 37.8.' },
  { title: 'Assessment', content: '' },
  { title: 'Plan', content: '' },
];

describe('TASK-939 — buildTurnResponseFormat', () => {
  const format = buildTurnResponseFormat(compiled);
  const schema = format.json_schema as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };

  it('declares every section of the template and nothing else', () => {
    expect(Object.keys(schema.properties)).toEqual(compiled.sectionKeys);
    expect(schema.required).toEqual(compiled.sectionKeys);
    expect(schema.additionalProperties).toBe(false);
  });

  it('each section is an addition/revision/contradiction object — there is no field for the whole body', () => {
    for (const key of compiled.sectionKeys) {
      const property = schema.properties[key]!;
      // Nullable, so a turn can say "nothing for this section" without inventing text.
      const object = (property.anyOf as Array<Record<string, unknown>> | undefined)?.find((branch) => branch.type === 'object') ?? property;
      const fields = Object.keys((object.properties ?? {}) as Record<string, unknown>);
      expect(fields.sort()).toEqual(['addition', 'contradiction', 'revision']);
      expect(fields).not.toContain('content');
    }
  });

  it('stays strict — a model cannot emit a key the template did not declare', () => {
    expect(format.strict).toBe(true);
    expect(format.type).toBe('json_schema');
  });
});

describe('TASK-939 — parseTurnJson', () => {
  it('parses additions and ignores sections the turn left null', () => {
    const turn = parseTurnJson(
      JSON.stringify({ subjective: { addition: 'Now reports fever.', revision: null, contradiction: null }, objective: null, assessment: null, plan: null }),
      compiled,
    );

    expect(turn).not.toBeNull();
    expect(turn!.subjective).toEqual({ addition: 'Now reports fever.' });
    expect(turn!.objective).toBeUndefined();
  });

  it('returns null for non-JSON, so the caller can fall back', () => {
    expect(parseTurnJson('Subjective: cough for three days.', compiled)).toBeNull();
    expect(parseTurnJson('', compiled)).toBeNull();
  });

  it('returns null when the object carries no section the template declares', () => {
    expect(parseTurnJson(JSON.stringify({ nonsense: { addition: 'x' } }), compiled)).toBeNull();
  });

  it('tolerates a fenced code block, which models emit unprompted', () => {
    const turn = parseTurnJson('```json\n{"subjective":{"addition":"Fever.","revision":null,"contradiction":null}}\n```', compiled);
    expect(turn?.subjective?.addition).toBe('Fever.');
  });
});

describe('TASK-939 — applyTurn', () => {
  it('APPENDS: the prior body is a prefix of the new one, and the write carries only the new part', () => {
    const turn = { subjective: { addition: 'Now reports fever.' } };

    const { sections, writes } = applyTurn(prior, turn, compiled);

    expect(sections[0]!.content).toBe('Cough for three days.\n\nNow reports fever.');
    expect(sections[0]!.content.startsWith(prior[0]!.content)).toBe(true);
    expect(writes).toEqual([{ sectionKey: 'subjective', title: 'Subjective', idx: 0, mode: 'append', content: 'Now reports fever.' }]);
  });

  it('emits NO write for a section the turn did not touch — a quiet section costs nothing', () => {
    const { writes } = applyTurn(prior, { subjective: { addition: 'Fever.' } }, compiled);

    expect(writes.map((write) => write.sectionKey)).toEqual(['subjective']);
  });

  it('fills an empty section without a leading separator', () => {
    const { sections, writes } = applyTurn(prior, { assessment: { addition: 'Likely viral URI.' } }, compiled);

    expect(sections[2]!.content).toBe('Likely viral URI.');
    expect(writes[0]).toMatchObject({ sectionKey: 'assessment', mode: 'append' });
  });

  it('REVISES only with a contradiction, and passes the reason to the store', () => {
    const turn = { objective: { revision: 'Temp 39.1.', contradiction: 'Nurse restated the temperature as 39.1.' } };

    const { sections, writes } = applyTurn(prior, turn, compiled);

    expect(sections[1]!.content).toBe('Temp 39.1.');
    expect(writes).toEqual([
      {
        sectionKey: 'objective',
        title: 'Objective',
        idx: 1,
        mode: 'replace',
        content: 'Temp 39.1.',
        contradiction: { reason: 'Nurse restated the temperature as 39.1.' },
      },
    ]);
  });

  it('THE GUARD: a revision with no contradiction is REFUSED and the prior text stands', () => {
    const turn = { objective: { revision: 'Temp thirty-seven point eight degrees.' } };

    const { sections, writes, refusals } = applyTurn(prior, turn, compiled);

    expect(sections[1]!.content).toBe('Temp 37.8.');
    expect(writes).toEqual([]);
    expect(refusals).toEqual([{ sectionKey: 'objective', reason: 'revision-without-contradiction' }]);
  });

  it('a revision of an EMPTY section needs no contradiction — there is nothing to contradict', () => {
    const { sections, writes } = applyTurn(prior, { plan: { revision: 'Rest and fluids.' } }, compiled);

    expect(sections[3]!.content).toBe('Rest and fluids.');
    expect(writes[0]).toMatchObject({ sectionKey: 'plan', mode: 'replace' });
  });

  it('ignores a whitespace-only addition rather than bumping a revision for nothing', () => {
    const { sections, writes } = applyTurn(prior, { subjective: { addition: '   \n ' } }, compiled);

    expect(sections[0]!.content).toBe('Cough for three days.');
    expect(writes).toEqual([]);
  });

  it('an addition ALREADY present in the section is dropped — a model repeating itself must not duplicate the note', () => {
    const { sections, writes } = applyTurn(prior, { subjective: { addition: 'Cough for three days.' } }, compiled);

    expect(sections[0]!.content).toBe('Cough for three days.');
    expect(writes).toEqual([]);
  });

  it('prefers `revision` when a turn supplies both, since a contradiction is the stronger claim', () => {
    const turn = { objective: { addition: 'Also pale.', revision: 'Temp 39.1.', contradiction: 'Restated as 39.1.' } };

    const { sections, writes } = applyTurn(prior, turn, compiled);

    expect(sections[1]!.content).toBe('Temp 39.1.');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.mode).toBe('replace');
  });

  it('returns the sections in the template’s authored order, whatever order the turn used', () => {
    const turn = { plan: { addition: 'Review in a week.' }, subjective: { addition: 'Fever.' } };

    const { sections } = applyTurn(prior, turn, compiled);

    expect(sections.map((section) => section.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
  });

  it('starts from an EMPTY prior note (the first turn of a session) without inventing sections', () => {
    const { sections, writes } = applyTurn([], { subjective: { addition: 'Cough for three days.' } }, compiled);

    expect(sections.map((section) => section.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(sections[0]!.content).toBe('Cough for three days.');
    expect(writes).toHaveLength(1);
  });
});

describe('TASK-939 — wholeDocumentAsTurn (the degrade path)', () => {
  it('passes the parsed list through VERBATIM, including the prose parser’s single-section fallback', () => {
    const fallback = [{ title: 'Running Summary', content: 'Everything the model said, unparsed.' }];

    const { sections, writes } = wholeDocumentAsTurn(fallback, compiled);

    // Re-keying onto `sectionKeys` here would discard the fallback and publish an empty note.
    expect(sections).toEqual(fallback);
    expect(writes).toEqual([{ sectionKey: 'subjective', title: 'Running Summary', idx: 0, mode: 'replace', content: 'Everything the model said, unparsed.' }]);
  });

  it('reproduces the pre-ticket behaviour: every populated section is a REPLACE', () => {
    const parsed = [
      { title: 'Subjective', content: 'Cough for three days. Now fever.' },
      { title: 'Objective', content: 'Temp 37.8.' },
      { title: 'Assessment', content: '' },
      { title: 'Plan', content: '' },
    ];

    const { sections, writes, refusals } = wholeDocumentAsTurn(parsed, compiled);

    expect(sections).toEqual(parsed);
    expect(writes.map((write) => [write.sectionKey, write.mode])).toEqual([
      ['subjective', 'replace'],
      ['objective', 'replace'],
    ]);
    expect(refusals).toEqual([]);
  });

  it('emits no write for an empty section, so a provider omitting one cannot blank the note', () => {
    const { writes } = wholeDocumentAsTurn([{ title: 'Subjective', content: 'Only this.' }], compiled);

    expect(writes.map((write) => write.sectionKey)).toEqual(['subjective']);
  });

  it('carries no contradiction — the store applies its own deletion rule, unchanged', () => {
    const { writes } = wholeDocumentAsTurn([{ title: 'Subjective', content: 'Text.' }], compiled);

    expect(writes[0]).not.toHaveProperty('contradiction');
  });
});

describe('TASK-939 — a WHOLE-DOCUMENT output is not an empty turn', () => {
  /**
   * The failure this pins, found by the pre-existing live-documentation suite: a model (or a test
   * fixture) answering with `{ subjective: "text", … }` carries every declared KEY, so an
   * `sawDeclaredKey`-only check read it as a turn in which every section contributed nothing — and
   * the note came out EMPTY. A string value means "here is the whole section", which is the
   * document contract, not the turn contract, and must fall through to the degrade path.
   */
  it('returns null when a declared section carries a STRING (the document contract)', () => {
    const raw = JSON.stringify({ subjective: 'Cough for three days.', objective: 'Temp 37.8.', assessment: null, plan: null });

    expect(parseTurnJson(raw, compiled)).toBeNull();
  });

  it('still accepts a turn in which EVERY section is null — that is a quiet turn, not a document', () => {
    const raw = JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null });

    expect(parseTurnJson(raw, compiled)).toEqual({});
  });

  it('accepts a mix of nulls and turn objects', () => {
    const raw = JSON.stringify({ subjective: { addition: 'Fever.', revision: null, contradiction: null }, objective: null, assessment: null, plan: null });

    expect(parseTurnJson(raw, compiled)?.subjective?.addition).toBe('Fever.');
  });
});

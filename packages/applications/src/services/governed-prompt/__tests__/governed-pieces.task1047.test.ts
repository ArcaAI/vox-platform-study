/**
 * TASK-1047 FC-1/FC-2 — the static pieces an authoring-time screen registers.
 *
 * A piece is the instruction text AS THE SYSTEM MESSAGE WILL CARRY IT: every placeholder rendered
 * as the fixed pointer `[see the <block> data section below]` (FC-1), so the digest registered at
 * publish is the digest the composer emits at call time, and no runtime value can be in it.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pieceDigest, piecesFromResolvedPrompt, pointerBlockName, renderPointerMode, templateBodyPiece } from '../governed-pieces';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('pointer rendering (FC-1, local until L1 ships the contract option)', () => {
  it('derives the block name: lower-case, every non [a-z0-9] run → _', () => {
    expect(pointerBlockName('trigger.context.formatted_vitals')).toBe('trigger_context_formatted_vitals');
    expect(pointerBlockName('chiefComplaint')).toBe('chiefcomplaint');
    expect(pointerBlockName('a..B--c')).toBe('a_b_c');
  });

  it('renders every placeholder (with or without default) as the pointer and keeps text verbatim', () => {
    expect(renderPointerMode('Age: {{ safe_age }}; CC: {{trigger.context.chief_complaint | default("none")}}.')).toBe(
      'Age: [see the safe_age data section below]; CC: [see the trigger_context_chief_complaint data section below].',
    );
  });

  it('honours an established alias for a path', () => {
    expect(renderPointerMode('{{trigger.patientAge}}')).toBe('[see the trigger_patientage data section below]');
    expect(renderPointerMode('{{test_results}}', { test_results: 'formatted_test_results' })).toBe(
      '[see the formatted_test_results data section below]',
    );
  });

  it('keeps the {{{{ escape and leaves a malformed placeholder literal', () => {
    expect(renderPointerMode('literal {{{{x}} and {{ 9bad }}')).toBe('literal {{x}} and {{ 9bad }}');
  });

  it('a single brace is literal', () => {
    expect(renderPointerMode('{language_name}')).toBe('{language_name}');
  });
});

describe('pieces and digests (FC-2)', () => {
  it('digest = sha256(utf8(text)) lower-case hex', () => {
    expect(pieceDigest('héllo')).toBe(sha('héllo'));
  });

  it('a template / inline instruction is ONE TEMPLATE_BODY piece keyed `body`, pointer-rendered', () => {
    const pieces = piecesFromResolvedPrompt(
      { source: 'template', promptTemplateId: 't', promptVersionNumber: 2, content: 'Vitals: {{formatted_vitals}}' },
      { sourceType: 'AGENT', sourceId: 'agent-1' },
    );
    expect(pieces).toEqual([
      {
        kind: 'TEMPLATE_BODY',
        sourceType: 'AGENT',
        sourceId: 'agent-1',
        sourceKey: 'body',
        text: 'Vitals: [see the formatted_vitals data section below]',
      },
    ]);
    expect(piecesFromResolvedPrompt({ source: 'inline', content: 'Be brief.' }, { sourceType: 'AGENT', sourceId: 'a' })[0]).toMatchObject({
      kind: 'TEMPLATE_BODY',
      sourceKey: 'body',
      text: 'Be brief.',
    });
  });

  it('a composite is one FRAGMENT piece per fragment, keyed by the fragment key', () => {
    const pieces = piecesFromResolvedPrompt(
      {
        source: 'composite',
        join: '\n\n',
        content: 'Base',
        fragments: [
          { key: 'base', source: 'inline', content: 'Base', when: null },
          { key: 'peds', source: 'template', promptTemplateId: 't', promptVersionNumber: 1, content: 'Age {{age}}', when: 'x' },
        ],
      },
      { sourceType: 'AGENT', sourceId: 'agent-1' },
    );
    expect(pieces.map((piece) => [piece.kind, piece.sourceKey, piece.text])).toEqual([
      ['FRAGMENT', 'base', 'Base'],
      ['FRAGMENT', 'peds', 'Age [see the age data section below]'],
    ]);
  });

  it('no prompt, an empty body, or an unknown shape yields no piece', () => {
    expect(piecesFromResolvedPrompt(null, { sourceType: 'AGENT', sourceId: 'a' })).toEqual([]);
    expect(piecesFromResolvedPrompt({ source: 'inline', content: '' }, { sourceType: 'AGENT', sourceId: 'a' })).toEqual([]);
    expect(piecesFromResolvedPrompt({ source: 'weird' }, { sourceType: 'AGENT', sourceId: 'a' })).toEqual([]);
  });

  it('a template body for approval is a PROMPT_VERSION TEMPLATE_BODY piece', () => {
    expect(templateBodyPiece('Hi {{x}}', 'tpl-1')).toEqual({
      kind: 'TEMPLATE_BODY',
      sourceType: 'PROMPT_VERSION',
      sourceId: 'tpl-1',
      sourceKey: 'body',
      text: 'Hi [see the x data section below]',
    });
  });
});

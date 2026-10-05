/**
 * TASK-1022 — the finalizer is told WHICH headings to keep, instead of "the headings in the
 * partial summaries" it was never shown.
 *
 * The durable finalize now receives (a) its input as headed Markdown (`## <title>`, harness
 * `_render_input_for_generation`) and (b) the frozen template's headings on the handoff context as
 * `document_headings`. The prompt binds (b) with a default, so a handoff that carries no headings
 * (no frozen template, the gateway finalize path) renders cleanly and falls back to the input's
 * own `##` headings. Every existing rule — fact preservation, PII, English, DNA style, the JSON
 * contract — is kept.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CASENOTE_FINALIZATION_SYSTEM_PROMPT, CLINICAL_NOTE_FRAGMENT_KEY, GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS } from '../25-agents';
import { ARCAAI_FINALIZATION_AGENT_SPEC } from '../29-arcaai-agents-and-workflows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);

const HEADINGS_BINDING = '{{trigger.context.document_headings | default("")}}';

/** The durable scope, built as `workflow.py#_publish_context` builds it from a handoff context. */
const durableScope = (live: Record<string, unknown>) => {
  const trigger = { ...live, context: { ...live } };
  return { trigger, context: trigger, vars: {}, nodes: {}, variables: {} };
};
const compose = (live: Record<string, unknown>) =>
  contract.composePrompt(
    { source: 'composite', fragments: [{ key: CLINICAL_NOTE_FRAGMENT_KEY, source: 'inline', content: CASENOTE_FINALIZATION_SYSTEM_PROMPT }] },
    durableScope(live),
  );

describe('TASK-1022 — the finalization prompt names the template headings', () => {
  it('binds the handoff`s `document_headings`, with a default', () => {
    expect(CASENOTE_FINALIZATION_SYSTEM_PROMPT).toContain(HEADINGS_BINDING);
  });

  it('no longer asks for headings "as they appear in the partial summaries"', () => {
    expect(CASENOTE_FINALIZATION_SYSTEM_PROMPT).not.toContain('exactly as they appear in the partial summaries');
  });

  it('states the heading rules: exact list and order, `##`, the input fallback, once each, the literal marker', () => {
    const prompt = CASENOTE_FINALIZATION_SYSTEM_PROMPT;
    expect(prompt).toContain('EXACTLY these headings, in exactly this order');
    expect(prompt).toContain('`## ` Markdown heading');
    expect(prompt).toContain('When the list above is empty, use the `## ` headings of the draft blocks instead, in the order they appear there');
    expect(prompt).toContain('Every heading appears exactly once');
    expect(prompt).toContain('gets exactly the line `Not discussed`');
    expect(prompt).toContain('Put each fact under the heading it belongs to');
  });

  it('records a diagnosis update the conversation states, without licensing inference', () => {
    const prompt = CASENOTE_FINALIZATION_SYSTEM_PROMPT;
    expect(prompt).toContain('record the diagnosis the conversation states, including every update the conversation makes to it');
    expect(prompt).toContain('a diagnosis the conversation does not state is never written');
    expect(prompt).not.toMatch(/\binfer (a|the) diagnos/i);
  });

  it('keeps every existing rule', () => {
    const prompt = CASENOTE_FINALIZATION_SYSTEM_PROMPT;
    expect(prompt).toContain('Every number, dose, unit, date and drug name is copied verbatim from its source');
    expect(prompt).toContain('Redact residual PII');
    expect(prompt).toContain('never add findings, diagnoses, recommendations or plans of your own, and never write a clinical code');
    expect(prompt).toContain('THE FINALIZED NOTE IS ENTIRELY IN ENGLISH');
    expect(prompt).toContain('=== WRITING STYLE ===');
    expect(prompt).toContain('{{context.dna_style_text | default("")}}');
    expect(prompt).toContain('Return a JSON object with `case_note` (the finalized Markdown note), `redactions` (an array of `{ text, label }`) and `sources`');
  });

  it('renders the numbered heading list into the durable prompt', () => {
    const composed = compose({ document_headings: '1. New Complaints\n2. Investigations\n3. Current Diagnosis' });
    expect(composed.selected).toEqual([CLINICAL_NOTE_FRAGMENT_KEY]);
    expect(composed.prompt).toContain('The document template headings, in order, are:\n1. New Complaints\n2. Investigations\n3. Current Diagnosis\n');
  });

  it('renders cleanly when the handoff carries no headings (the default applies)', () => {
    const composed = compose({ visit_type: 'new-visit' });
    expect(composed.selected).toEqual([CLINICAL_NOTE_FRAGMENT_KEY]);
    expect(composed.prompt).toContain('The document template headings, in order, are:\n\nWrite the note');
    expect(composed.prompt).not.toContain('{{');
  });

  it('is the body of every seeded `casenote-finalization`: SYSTEM, Global and ArcaAI', () => {
    const rows = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC].filter(
      (spec) => spec.slug === 'casenote-finalization',
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const [first] = (row.instruction as { fragments: Array<{ key: string; systemPrompt?: string }> }).fragments;
      expect(first, row.tenantId).toEqual({ key: CLINICAL_NOTE_FRAGMENT_KEY, systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT });
    }
  });
});

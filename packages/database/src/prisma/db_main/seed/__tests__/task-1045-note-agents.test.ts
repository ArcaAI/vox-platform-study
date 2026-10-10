/**
 * TASK-1045 lane E7 — the note agents.
 *
 *  - the finalizer reads the TRANSCRIPT (labelled blocks of every encounter), not live section text;
 *    `case_note` is unchanged and `sources` is optional;
 *  - a `fact-ledger-extraction` agent exists in SYSTEM and Global (ArcaAI receives it by clone);
 *  - every seeded LLM agent samples at temperature 0;
 *  - the summarization model is served at 65536 (8 slots, TASK-1059 OD-1) with a q4_0 KV cache and flash attention;
 *  - multi-encounter recall: the ledger keys facts `<category>:<term>` with numbers, and both note
 *    prompts (the finalizer agent and the SYSTEM catch-all SOAP template) carry allergies and current
 *    medications of every encounter.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../07-prompt-template';
import {
  CASENOTE_FINALIZATION_SYSTEM_PROMPT,
  CASENOTE_OUTPUT_SCHEMA,
  FACT_LEDGER_AGENT_SLUG,
  FACT_LEDGER_OUTPUT_SCHEMA,
  FACT_LEDGER_SYSTEM_PROMPT,
  GLOBAL_AGENT_SPECS,
  PLATFORM_AGENT_SPECS,
} from '../25-agents';
import { ARCAAI_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC } from '../29-arcaai-agents-and-workflows';
import { LLM_AI_MODELS } from '../ai-models/llm';

const ALL = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC];

describe('the finalizer is transcript-based', () => {
  const prompt = CASENOTE_FINALIZATION_SYSTEM_PROMPT;

  it('reads labelled transcript blocks of every encounter, ledgers, results and drafts', () => {
    expect(prompt).toContain('transcript blocks of EVERY encounter');
    expect(prompt).toContain('fact ledger');
    expect(prompt).toContain('results');
    expect(prompt).toContain('draft note blocks');
    expect(prompt).toContain('write it from the transcript, never from the draft');
  });

  it('states the grounding, latest-wins, verbatim-number and citation rules', () => {
    expect(prompt).toContain('every statement in the note must be supported');
    expect(prompt).toContain('the LATEST encounter wins');
    expect(prompt).toContain('states the change explicitly');
    expect(prompt).toContain('copied verbatim from its source');
    expect(prompt).toContain('`sources`');
  });

  it('keeps the headings, redaction and style bindings', () => {
    expect(prompt).toContain('{{trigger.context.document_headings | default("")}}');
    expect(prompt).toContain('{{context.dna_redaction_rules_text | default("")}}');
    expect(prompt).toContain('{{context.dna_style_text | default("")}}');
  });

  it('leaves case_note as it was and adds an OPTIONAL sources array', () => {
    const schema = CASENOTE_OUTPUT_SCHEMA as { required: string[]; properties: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(schema.required).toEqual(['case_note', 'redactions']);
    expect(schema.properties.case_note).toEqual({ type: 'string' });
    expect(schema.properties.sources.items.required).toEqual(['sectionKey', 'ids']);
    expect(schema.properties.sources.items.properties.ids).toEqual({ type: 'array', items: { type: 'string' } });
  });
});

describe('fact-ledger-extraction', () => {
  it('is seeded in SYSTEM and Global on the summarization model, temperature 0, reasoning off', () => {
    for (const rows of [PLATFORM_AGENT_SPECS, GLOBAL_AGENT_SPECS]) {
      const spec = rows.find((row) => row.slug === FACT_LEDGER_AGENT_SLUG);
      expect(spec, 'missing').toBeDefined();
      expect(spec!.task).toBe('TEXT_GENERATION');
      expect(spec!.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
      expect(spec!.parameters).toMatchObject({ generation: { temperature: 0, reasoning: { enabled: false } } });
      expect(spec!.outputSchema).toEqual(FACT_LEDGER_OUTPUT_SCHEMA);
      expect(spec!.status).toBe('PUBLISHED');
    }
  });

  it('returns a facts array whose every fact must cite', () => {
    const items = (FACT_LEDGER_OUTPUT_SCHEMA as any).properties.facts.items; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(items.required).toEqual(expect.arrayContaining(['key', 'kind', 'statement', 'citations']));
    expect(items.properties.kind.enum).toContain('dose_change');
  });
});

describe('multi-encounter recall', () => {
  it('the ledger keys every fact `<category>:<term>`, keeps a dose change on the drug key, and lists numbers', () => {
    const prompt = FACT_LEDGER_SYSTEM_PROMPT;
    expect(prompt).toContain('`key` is `<category>:<term>`');
    expect(prompt).toContain('`allergy:penicillin`, `medication:metformin`');
    expect(prompt).toContain('ONE fact of kind `dose_change` keyed with the drug');
    expect(prompt).toContain('never a second key such as `metformin_dose_change`');
    expect(prompt).toContain('A fact whose statement contains a number never has empty `numbers`');
  });

  it('the ledger keeps every allergy as its own critical fact', () => {
    expect(FACT_LEDGER_SYSTEM_PROMPT).toContain('every allergy the transcript states is its own fact of kind `allergy` with `critical` true');
  });

  it('the finalizer carries allergies and current medications of every encounter, cited', () => {
    const prompt = CASENOTE_FINALIZATION_SYSTEM_PROMPT;
    expect(prompt).toContain('=== COMPLETENESS ===');
    expect(prompt).toContain('The note covers EVERY encounter, not only the latest one.');
    expect(prompt).toContain('begins with `Allergies:`');
    expect(prompt).toContain('A fact from an earlier encounter stays in the note unless a later encounter changes it.');
    // The block sits before the output contract, so the contract stays the prompt's last word.
    expect(prompt.indexOf('=== COMPLETENESS ===')).toBeLessThan(prompt.indexOf('Return a JSON object with `case_note`'));
  });

  it('the SYSTEM catch-all SOAP template asks for allergies and current medications under Subjective', () => {
    const soap = DEFAULT_PROMPT_TEMPLATES.find((row) => row.id === TEMPLATE_IDS.CATCHALL_SOAP)!;
    const subjective = soap.content.slice(soap.content.indexOf('**Subjective**'), soap.content.indexOf('**Objective**'));
    expect(subjective).toContain('- Allergies with the reaction, from every encounter (never omitted when stated)');
    expect(subjective).toContain('- Current medications with dose and frequency, from every encounter');
  });

  it('no prompt names a ticket', () => {
    for (const text of [FACT_LEDGER_SYSTEM_PROMPT, CASENOTE_FINALIZATION_SYSTEM_PROMPT]) expect(text).not.toMatch(/TASK-\d+/);
  });
});

describe('every seeded LLM agent samples at temperature 0', () => {
  it.each(ALL.filter((spec) => spec.task === 'TEXT_GENERATION').map((spec) => [`${spec.tenantId}/${spec.slug}`, spec] as const))('%s', (_n, spec) => {
    expect((spec.parameters as any).generation.temperature).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

describe('the gemma serving profile', () => {
  const gemma = LLM_AI_MODELS.find((model) => model.slug === 'lms-gemma-4-e2b-it-qat')!;

  it('declares and serves 65536 x 8 with a q4_0 KV cache and flash attention (TASK-1059 OD-1)', () => {
    expect(gemma.metaData?.contextLength).toBe(65536);
    expect(gemma.metaData?.serving).toMatchObject({
      contextLength: 65536,
      parallel: 8,
      flashAttention: true,
      kvCacheQuant: { k: 'q4_0', v: 'q4_0' },
    });
  });
});

/**
 * TASK-1036 (W2, OD-16) — every seeded `AiModel` row declares its capabilities at
 * `_metadata.capabilities`, truthfully, and without hiding what the row already declared flat.
 *
 * Why the second half matters: every reader (`AgentService.capabilitiesOf`, the workflow publish
 * gate, the catalogue mapper) takes `metaData.capabilities` WHEN IT IS AN OBJECT and ignores the
 * flat `metaData` then. A nested object that omitted `supportedGenerationParams` would turn the
 * generation-parameter gate off for that row without a sound.
 *
 * The contract is imported from SOURCE so the shape is checked against `ModelCapabilities` and the
 * editor's own capability gate (`tenantEditableParams`), not against this file's idea of it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS } from '../06-ai-models';
import { REASONING_MODEL_SLUGS, capabilityFlagsFor } from '../ai-models/capabilities';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);

const isVerbArray = (model: (typeof DEFAULT_AI_MODELS)[number]) => Array.isArray(model.metaData?.capabilities);
const flagged = DEFAULT_AI_MODELS.filter((model) => !isVerbArray(model));
const capsOf = (slug: string) => DEFAULT_AI_MODELS.find((model) => model.slug === slug)!.metaData!.capabilities as any;

describe('every seeded model row declares its capability flags', () => {
  it('all rows except the three NLP verb-array rows carry the descriptor', () => {
    expect(DEFAULT_AI_MODELS.length - flagged.length).toBe(3);
    expect(
      DEFAULT_AI_MODELS.filter(isVerbArray)
        .map((model) => model.slug)
        .sort(),
    ).toEqual(['gliguard-llm-guardrails-300m', 'gliner2-guardrails-pii-multi', 'gliner2-privacy-filter-pii-multi']);
    for (const model of flagged) {
      const caps = model.metaData?.capabilities as any;
      expect(caps, model.slug).toBeTypeOf('object');
      for (const flag of ['supportsTools', 'supportsVision', 'supportsAttachments', 'reasoning'])
        expect(typeof caps[flag], `${model.slug}.${flag}`).toBe('boolean');
      expect(Array.isArray(caps.voices), `${model.slug}.voices`).toBe(true);
    }
  });

  it('the verb arrays the NLP envelope reads are untouched', () => {
    expect(DEFAULT_AI_MODELS.find((model) => model.slug === 'gliner2-guardrails-pii-multi')?.metaData?.capabilities).toEqual([
      'extract_entities',
      'classify_text',
    ]);
  });

  it('claims nothing it cannot back: no tools, vision or attachments anywhere; reasoning only where the seed already documents a reasoning model', () => {
    for (const model of flagged) {
      const caps = model.metaData!.capabilities as any;
      expect(caps.supportsTools, model.slug).toBe(false);
      expect(caps.supportsVision, model.slug).toBe(false);
      expect(caps.supportsAttachments, model.slug).toBe(false);
      expect(caps.reasoning, model.slug).toBe(REASONING_MODEL_SLUGS.includes(model.slug));
    }
    expect(REASONING_MODEL_SLUGS).toEqual(['azure-gpt-5.4-mini']);
  });

  it('TTS rows list exactly the voice ids their flat catalogue offers; every other row lists none', () => {
    for (const model of flagged) {
      const expected = (model.metaData?.voices ?? []).map((voice) => voice.id);
      expect((model.metaData!.capabilities as any).voices, model.slug).toEqual(expected);
      if (model.taskType !== 'TEXT_TO_SPEECH') expect(expected, model.slug).toEqual([]);
    }
    expect(capsOf('kokoro').voices.length).toBeGreaterThan(0);
  });
});

describe('the nested descriptor does not mask what the row declares flat', () => {
  it('supportedGenerationParams and contextLength are copied verbatim when declared, absent when not', () => {
    for (const model of flagged) {
      const caps = model.metaData!.capabilities as any;
      const meta = model.metaData as any;
      expect(caps.supportedGenerationParams, model.slug).toEqual(meta.supportedGenerationParams);
      expect(caps.contextLength, model.slug).toEqual(meta.contextLength);
    }
    expect(capsOf('lms-gemma-4-e2b-it-qat').contextLength).toBeGreaterThan(0);
  });

  it('is a pure function of the row: capabilityFlagsFor reproduces the seeded descriptor', () => {
    for (const model of flagged) expect(capabilityFlagsFor(model)).toEqual(model.metaData!.capabilities);
  });
});

describe('the contract reads the seeded descriptor as ModelCapabilities', () => {
  it('a text model offers temperature and max tokens; the reasoning deployment hides temperature; a TTS model offers its voices', () => {
    const editable = (slug: string, task: string) => contract.tenantEditableParams(task, capsOf(slug));
    expect(editable('lms-gemma-4-e2b-it-qat', 'TEXT_GENERATION')).toEqual(expect.arrayContaining(['generation.temperature', 'generation.maxTokens']));
    expect(editable('azure-gpt-5.4-mini', 'TEXT_GENERATION')).not.toContain('generation.temperature');
    expect(editable('azure-gpt-5.4-mini', 'TEXT_GENERATION')).toContain('generation.maxTokens');
    expect(editable('kokoro', 'TEXT_TO_SPEECH')).toContain('voice');
  });
});

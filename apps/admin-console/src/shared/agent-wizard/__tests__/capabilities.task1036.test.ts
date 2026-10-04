/**
 * TASK-1036 C5 (W2, OD-16) — what the simple agent editor offers, decided from the bound model's
 * declared capabilities and the contract's tenant-editable list.
 */
import { describe, expect, it } from 'vitest';
import type { ModelCapabilities } from '@arcaai/workflow-contract';
import { capabilitiesOf, futureSectionsFor, hasEditablePath, platformSchemaFilter } from '../capabilities';

const llm: ModelCapabilities = {
  supportsTools: true,
  supportsVision: true,
  supportsAttachments: true,
  voices: [],
  supportedGenerationParams: ['temperature', 'maxTokens'],
};

describe('capabilitiesOf', () => {
  it('reads the catalogue row, and is null when the row (or an older gateway) carries none', () => {
    expect(capabilitiesOf({ capabilities: llm })).toBe(llm);
    expect(capabilitiesOf({})).toBeNull();
    expect(capabilitiesOf(undefined)).toBeNull();
  });
});

describe('hasEditablePath', () => {
  it('offers temperature and max tokens only when the model supports them', () => {
    expect(hasEditablePath('TEXT_GENERATION', llm, 'generation.temperature')).toBe(true);
    expect(hasEditablePath('TEXT_GENERATION', llm, 'generation.maxTokens')).toBe(true);
    expect(hasEditablePath('TEXT_GENERATION', { ...llm, supportedGenerationParams: ['maxTokens'] }, 'generation.temperature')).toBe(false);
  });

  it('hides temperature for a reasoning model', () => {
    expect(hasEditablePath('TEXT_GENERATION', { ...llm, reasoning: true }, 'generation.temperature')).toBe(false);
  });

  it('withholds every capability-gated knob while capabilities are unknown, but keeps the plain switches', () => {
    expect(hasEditablePath('TEXT_GENERATION', null, 'generation.temperature')).toBe(false);
    expect(hasEditablePath('TEXT_GENERATION', null, 'dna.enabled')).toBe(true);
    expect(hasEditablePath('SPEECH_TO_TEXT', null, 'audioFrontEnd.vad.enabled')).toBe(true);
  });

  it('offers a TTS voice only when the model lists voices', () => {
    expect(hasEditablePath('TEXT_TO_SPEECH', { ...llm, voices: ['ava'] }, 'voice')).toBe(true);
    expect(hasEditablePath('TEXT_TO_SPEECH', llm, 'voice')).toBe(false);
    expect(hasEditablePath('TEXT_TO_SPEECH', llm, 'speed')).toBe(true);
  });

  it('never offers a platform-managed path', () => {
    expect(hasEditablePath('TEXT_GENERATION', llm, 'generation.topP')).toBe(false);
    expect(hasEditablePath('SPEECH_TO_TEXT', llm, 'decoding.beamSize')).toBe(false);
  });
});

describe('futureSectionsFor (OD-16)', () => {
  it('keeps tools and attachments hidden even when the model declares them', () => {
    expect(futureSectionsFor(llm)).toEqual({ tools: false, attachments: false });
    expect(futureSectionsFor(null)).toEqual({ tools: false, attachments: false });
  });
});

describe('platformSchemaFilter', () => {
  it('keeps exactly the platform-managed leaves for a super admin\'s collapsed "Platform tuning" section', () => {
    const keep = platformSchemaFilter('TEXT_GENERATION');
    expect(keep('generation.topP')).toBe(true);
    expect(keep('generation.reasoning.enabled')).toBe(true);
    expect(keep('generation.temperature')).toBe(false);
    expect(keep('dna.enabled')).toBe(false);
  });
});

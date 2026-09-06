/**
 * TASK-890 §3.7a — the PURE half of the BYO model declaration.
 *
 * The slug a declaration generates is the tenant's routing key for that model
 * FOREVER (an agent binds `modelId`, a picker resolves by slug), so it is
 * server-generated, stable and derived from facts the tenant already gave:
 * the connection's provider and the vendor wire id. These tests pin the
 * generation, the `byo-` escape hatch used when a generated slug would shadow a
 * platform row, and the per-service vocabulary a declared row must carry.
 */
import { describe, expect, it } from 'vitest';
import { ModelTaskType } from '@arcaai/domains';
import {
  BYO_DECLARABLE_SERVICES,
  byoLibraryFor,
  byoModelSlug,
  byoServedByFor,
  isTaskTypeOfService,
  suggestedByoModelSlug,
} from '../byo-model-declaration';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

describe('byoModelSlug', () => {
  it('is `<provider>-<slugified wire id>` and always satisfies the AiModel slug rule', () => {
    expect(byoModelSlug('azure', 'gpt-4o-mini')).toBe('azure-gpt-4o-mini');
    expect(byoModelSlug('openai', 'GPT-4.1')).toBe('openai-gpt-4-1');
    expect(byoModelSlug('anthropic', 'claude_sonnet:v2')).toBe('anthropic-claude-sonnet-v2');
    for (const slug of [byoModelSlug('azure', 'gpt-4o-mini'), byoModelSlug('openai', 'GPT-4.1'), byoModelSlug('anthropic', 'claude_sonnet:v2')]) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
  });

  it('is stable: the same (provider, wire id) always yields the same slug', () => {
    expect(byoModelSlug('azure', 'my prod deployment')).toBe(byoModelSlug('azure', 'my prod deployment'));
    expect(byoModelSlug('azure', 'my prod deployment')).toBe('azure-my-prod-deployment');
  });

  it('refuses a wire id with nothing sluggable in it rather than inventing a name', () => {
    expect(() => byoModelSlug('azure', '   ')).toThrow();
    expect(() => byoModelSlug('azure', '---')).toThrow();
  });

  it('suggests the `byo-` prefixed form for the slug-shadow escape hatch (P-29)', () => {
    expect(suggestedByoModelSlug('azure', 'gpt-4o-mini')).toBe('byo-azure-gpt-4o-mini');
  });
});

describe('the per-service vocabulary a declared row must carry', () => {
  it('declares exactly the three model-bearing inference services (§3.7a)', () => {
    expect([...BYO_DECLARABLE_SERVICES]).toEqual(['llm', 'stt', 'tts']);
  });

  it('maps the service to the workload that EXECUTES the row', () => {
    expect(byoServedByFor('llm')).toBe('text');
    expect(byoServedByFor('stt')).toBe('stt');
    expect(byoServedByFor('tts')).toBe('tts');
  });

  it('maps the connection provider to a serving library the registry vocabulary knows', () => {
    expect(byoLibraryFor('llm', 'azure')).toBe('azure-openai');
    expect(byoLibraryFor('tts', 'azure')).toBe('azure-speech');
    expect(byoLibraryFor('llm', 'openai')).toBe('openai');
    expect(byoLibraryFor('stt', 'azure-speech')).toBe('azure-speech');
    expect(byoLibraryFor('llm', 'anthropic')).toBe('anthropic');
  });

  it('accepts only task types the service governs', () => {
    expect(isTaskTypeOfService('llm', ModelTaskType.TEXT_GENERATION)).toBe(true);
    expect(isTaskTypeOfService('llm', ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)).toBe(false);
    expect(isTaskTypeOfService('stt', ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)).toBe(true);
    expect(isTaskTypeOfService('tts', ModelTaskType.TEXT_TO_SPEECH)).toBe(true);
  });
});

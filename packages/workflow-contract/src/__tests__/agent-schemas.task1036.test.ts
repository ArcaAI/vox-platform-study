/**
 * TASK-1036 (W2, W3, OD-7, OD-8, OD-16) — the agent contract's simple-configuration surface.
 *
 *  - every parameter leaf is `x-platformManaged` except the tenant-editable allow-list
 *    (temperature, max output tokens and the §8.6 task switches);
 *  - `platformManagedPaths` / `tenantEditableParams` read that one declaration;
 *  - TEXT_GENERATION gains `instruction.documentTemplate { slug }` (always latest, never a version)
 *    and `parameters.dna { enabled }`;
 *  - the TEXT input default is `{ message }`, with `text` as a deprecated alias — exactly one;
 *  - publish refuses an unpinned library prompt (`PROMPT_VERSION_UNPINNED`), drafts do not.
 */
import { authorableJsonSchemaProblems, jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTION_SCHEMAS,
  AGENT_IO_DEFAULTS,
  AGENT_PARAMETER_SCHEMAS,
  AGENT_TASKS,
  PLATFORM_MANAGED_KEYWORD,
  TENANT_EDITABLE_PARAMETER_PATHS,
  agentConfigProblems,
  platformManagedPaths,
  readTextAgentMessage,
  tenantEditableParams,
  type AgentTask,
  type ModelCapabilities,
} from '../agent-schemas';

type Schema = Record<string, unknown>;

/** Every leaf (a property schema without its own `properties`) as `[dottedPath, schema]`. */
function leaves(schema: Schema, prefix: string[] = []): Array<[string, Schema]> {
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (!properties) return [];
  const out: Array<[string, Schema]> = [];
  for (const [name, child] of Object.entries(properties)) {
    const path = [...prefix, name];
    if (child.properties && typeof child.properties === 'object') out.push(...leaves(child, path));
    else out.push([path.join('.'), child]);
  }
  return out;
}

const CAPS: ModelCapabilities = {
  supportsTools: false,
  supportsVision: false,
  supportsAttachments: false,
  voices: [],
  supportedGenerationParams: ['temperature', 'maxTokens', 'topP'],
};

describe('x-platformManaged — every parameter except the tenant-editable allow-list (W2)', () => {
  it('the keyword is the documented annotation name', () => {
    expect(PLATFORM_MANAGED_KEYWORD).toBe('x-platformManaged');
  });

  it.each(AGENT_TASKS)('%s: every non-editable leaf carries the annotation, every editable one does not', (task) => {
    const editable = new Set(TENANT_EDITABLE_PARAMETER_PATHS[task]);
    const all = leaves(AGENT_PARAMETER_SCHEMAS[task] as Schema);
    expect(all.length).toBeGreaterThan(0);
    for (const [path, schema] of all) {
      if (editable.has(path)) expect(schema[PLATFORM_MANAGED_KEYWORD], path).toBeUndefined();
      else expect(schema[PLATFORM_MANAGED_KEYWORD], path).toBe(true);
    }
    // Every allow-listed path is a real leaf: a typo would silently lock nothing.
    const leafPaths = new Set(all.map(([path]) => path));
    for (const path of editable) expect(leafPaths.has(path), path).toBe(true);
  });

  it('TEXT_GENERATION keeps temperature and maxTokens tenant-editable, locks every other generation knob', () => {
    const managed = platformManagedPaths('TEXT_GENERATION');
    expect(managed).not.toContain('generation.temperature');
    expect(managed).not.toContain('generation.maxTokens');
    for (const path of [
      'generation.topP',
      'generation.frequencyPenalty',
      'generation.presencePenalty',
      'generation.seed',
      'generation.stopSequences',
      'generation.reasoning.enabled',
      'generation.reasoning.effort',
      'memory',
      'guards.input',
      'fallback.autoSwitch',
    ]) {
      expect(managed, path).toContain(path);
    }
  });

  it('SPEECH_TO_TEXT locks decoding and VAD thresholds but keeps the three stage switches', () => {
    const managed = platformManagedPaths('SPEECH_TO_TEXT');
    for (const path of ['decoding.temperature', 'decoding.maxTokens', 'decoding.beamSize', 'audioFrontEnd.vad.threshold', 'streaming.partialWindowSec']) {
      expect(managed, path).toContain(path);
    }
    for (const path of ['audioFrontEnd.vad.enabled', 'audioFrontEnd.denoise.enabled', 'audioFrontEnd.diarization.enabled']) {
      expect(managed, path).not.toContain(path);
    }
  });

  it('keeps the existing readOnly lock and reports it as platform-managed too', () => {
    const asr = AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT as Schema;
    const embedding = leaves(asr).find(([path]) => path === 'audioFrontEnd.diarization.embeddingModelSlug')?.[1];
    expect(embedding?.readOnly).toBe(true);
    expect(platformManagedPaths('SPEECH_TO_TEXT')).toContain('audioFrontEnd.diarization.embeddingModelSlug');
  });

  it('NAMED_ENTITY_RECOGNITION exposes nothing to a tenant', () => {
    expect(TENANT_EDITABLE_PARAMETER_PATHS.NAMED_ENTITY_RECOGNITION).toEqual([]);
    expect(platformManagedPaths('NAMED_ENTITY_RECOGNITION')).toEqual(['threshold', 'aggregation']);
  });

  it('an annotated schema still validates every value it validated before (the keyword is an annotation)', () => {
    const parameters = { generation: { temperature: 0.2, topP: 0.9, seed: 7 }, responseFormat: 'text' };
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, parameters, 'parameters')).toEqual([]);
  });
});

describe('tenantEditableParams(task, capabilities)', () => {
  it('TEXT_GENERATION offers temperature and max tokens only when the model supports them', () => {
    expect(tenantEditableParams('TEXT_GENERATION', CAPS)).toEqual([
      'generation.temperature',
      'generation.maxTokens',
      'responseFormat',
      'responseSchema',
      'dna.enabled',
    ]);
    expect(tenantEditableParams('TEXT_GENERATION', { ...CAPS, supportedGenerationParams: ['maxTokens'] })).not.toContain('generation.temperature');
    expect(tenantEditableParams('TEXT_GENERATION', { ...CAPS, supportedGenerationParams: [] })).toEqual(['responseFormat', 'responseSchema', 'dna.enabled']);
  });

  it('hides temperature for a reasoning model', () => {
    const editable = tenantEditableParams('TEXT_GENERATION', { ...CAPS, reasoning: true });
    expect(editable).not.toContain('generation.temperature');
    expect(editable).toContain('generation.maxTokens');
  });

  it('unknown capabilities hide the capability-gated params', () => {
    expect(tenantEditableParams('TEXT_GENERATION', undefined)).toEqual(['responseFormat', 'responseSchema', 'dna.enabled']);
  });

  it('TEXT_TO_SPEECH offers the voice picker only when the model declares voices', () => {
    expect(tenantEditableParams('TEXT_TO_SPEECH', CAPS)).toEqual(['speed']);
    expect(tenantEditableParams('TEXT_TO_SPEECH', { ...CAPS, voices: ['alloy'] })).toEqual(['voice', 'speed']);
  });

  it('SPEECH_TO_TEXT offers the three stage switches', () => {
    expect(tenantEditableParams('SPEECH_TO_TEXT', CAPS)).toEqual([
      'audioFrontEnd.vad.enabled',
      'audioFrontEnd.denoise.enabled',
      'audioFrontEnd.diarization.enabled',
    ]);
  });

  it('never offers a path that is platform-managed', () => {
    for (const task of AGENT_TASKS as readonly AgentTask[]) {
      const managed = new Set(platformManagedPaths(task));
      for (const path of tenantEditableParams(task, { ...CAPS, voices: ['v'] })) expect(managed.has(path), `${task} ${path}`).toBe(false);
    }
  });
});

describe('TEXT_GENERATION instruction.documentTemplate { slug } — always latest approved (OD-7, OD-22)', () => {
  const schema = AGENT_INSTRUCTION_SCHEMAS.TEXT_GENERATION as Schema;

  it('accepts a slug beside any prompt form', () => {
    const instruction = { systemPrompt: 'Write the note.', documentTemplate: { slug: 'soap-note' } };
    expect(jsonSchemaValueProblems(schema, instruction, 'instruction')).toEqual([]);
    expect(agentConfigProblems({ task: 'TEXT_GENERATION', instruction })).toEqual([]);
  });

  it('refuses a version pin by name, in words', () => {
    const instruction = { systemPrompt: 'x', documentTemplate: { slug: 'soap-note', versionNumber: 3 } };
    expect(jsonSchemaValueProblems(schema, instruction, 'instruction').length).toBeGreaterThan(0);
    const problems = agentConfigProblems({ task: 'TEXT_GENERATION', instruction });
    expect(problems).toEqual([
      expect.objectContaining({ severity: 'ERROR', path: 'instruction.documentTemplate.versionNumber', message: expect.stringMatching(/latest/) }),
    ]);
  });

  it('refuses a documentTemplate with no slug', () => {
    const problems = agentConfigProblems({ task: 'TEXT_GENERATION', instruction: { systemPrompt: 'x', documentTemplate: {} } });
    expect(problems).toEqual([expect.objectContaining({ severity: 'ERROR', path: 'instruction.documentTemplate.slug' })]);
  });
});

describe('TEXT_GENERATION parameters.dna { enabled } (OD-7)', () => {
  const schema = AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION;

  it('accepts the switch and refuses anything else', () => {
    expect(jsonSchemaValueProblems(schema, { dna: { enabled: true } }, 'parameters')).toEqual([]);
    expect(jsonSchemaValueProblems(schema, { dna: { enabled: 'yes' } }, 'parameters').length).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(schema, { dna: { enabled: true, version: 2 } }, 'parameters').length).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(schema, { dna: {} }, 'parameters').length).toBeGreaterThan(0);
  });
});

describe('TEXT input default `{ message }`, `text` a deprecated alias — exactly one (OD-8)', () => {
  const input = AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema;

  it('is an authorable schema', () => {
    expect(authorableJsonSchemaProblems(input)).toEqual([]);
  });

  it('accepts message, or text, never both, never neither', () => {
    expect(jsonSchemaValueProblems(input, { message: 'Hi' })).toEqual([]);
    expect(jsonSchemaValueProblems(input, { text: 'Hi' })).toEqual([]);
    expect(jsonSchemaValueProblems(input, { message: 'Hi', variables: { a: 'b' } })).toEqual([]);
    expect(jsonSchemaValueProblems(input, { message: 'Hi', text: 'Hi' }).length).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(input, {}).length).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(input, { variables: { a: 'b' } }).length).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(input, { message: '' }).length).toBeGreaterThan(0);
  });

  it('marks text deprecated in the schema', () => {
    const text = (input.properties as Record<string, Schema>).text;
    expect(text.deprecated).toBe(true);
  });

  it('readTextAgentMessage reads either spelling', () => {
    expect(readTextAgentMessage({ message: 'a' })).toBe('a');
    expect(readTextAgentMessage({ text: 'b' })).toBe('b');
    expect(readTextAgentMessage({})).toBeUndefined();
    expect(readTextAgentMessage(null)).toBeUndefined();
  });

  it('leaves the output default unchanged', () => {
    expect(AGENT_IO_DEFAULTS.TEXT_GENERATION.outputSchema).toEqual({ type: 'object', required: ['text'], properties: { text: { type: 'string' } } });
  });
});

describe('PROMPT_VERSION_UNPINNED — publish refuses an unpinned library prompt (W3)', () => {
  const unpinned = { task: 'TEXT_GENERATION' as const, instruction: { promptTemplateId: 'tpl-1' } };

  it('a draft check stays silent (the server stamps the pin on bind)', () => {
    expect(agentConfigProblems(unpinned)).toEqual([]);
    expect(agentConfigProblems(unpinned, { phase: 'draft' })).toEqual([]);
  });

  it('a publish check refuses it with the named code', () => {
    expect(agentConfigProblems(unpinned, { phase: 'publish' })).toEqual([
      expect.objectContaining({ severity: 'ERROR', path: 'instruction.promptVersionNumber', code: 'PROMPT_VERSION_UNPINNED' }),
    ]);
  });

  it('a pinned template passes publish', () => {
    expect(agentConfigProblems({ task: 'TEXT_GENERATION', instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 2 } }, { phase: 'publish' })).toEqual([]);
  });

  it('an unpinned template FRAGMENT is refused at its own path; inline fragments need no pin', () => {
    const instruction = {
      fragments: [
        { key: 'base', systemPrompt: 'Base.' },
        { key: 'lib', promptTemplateId: 'tpl-2' },
        { key: 'pinned', promptTemplateId: 'tpl-3', promptVersionNumber: 1 },
      ],
    };
    expect(agentConfigProblems({ task: 'TEXT_GENERATION', instruction }, { phase: 'publish' })).toEqual([
      expect.objectContaining({ severity: 'ERROR', path: 'instruction.fragments[1].promptVersionNumber', code: 'PROMPT_VERSION_UNPINNED' }),
    ]);
  });

  it('inline prompts are never unpinned', () => {
    expect(agentConfigProblems({ task: 'TEXT_GENERATION', instruction: { systemPrompt: 'x' } }, { phase: 'publish' })).toEqual([]);
  });
});

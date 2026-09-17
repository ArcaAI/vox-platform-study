/**
 * TASK-930 §2 / §5 — NER is a first-class agent task, and `outputSchema` is enforced.
 *
 * Two independent commitments live in one file because they land in one module:
 *   §2  `NAMED_ENTITY_RECOGNITION` joins the task taxonomy, backed by a `TOKEN_CLASSIFICATION`
 *       registry row, with its own instruction (`labels`) and parameter (`threshold`,
 *       `aggregation`) allow-lists and the IO defaults the gateway and the harness both map to.
 *   §5  `outputSchemaResponseFormat` turns a declared `outputSchema` into the engine's
 *       `json_schema` response format — so the column stops being decorative — while an explicit
 *       `parameters.responseFormat` always wins.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTION_SCHEMAS,
  AGENT_IO_DEFAULTS,
  AGENT_PARAMETER_SCHEMAS,
  AGENT_TASKS,
  AGENT_TASK_MODEL_TASK_TYPE,
  AGENT_TASK_SERVICE,
  agentConfigProblems,
  hasBlockingAgentProblems,
  isAgentTask,
  outputSchemaResponseFormat,
} from '../agent-schemas';

const nerModel = { slug: 'medical-ner', taskType: 'TOKEN_CLASSIFICATION', provider: 'built-in' };

describe('TASK-930 §2 — NAMED_ENTITY_RECOGNITION joins the task taxonomy', () => {
  it('is a task', () => {
    expect(AGENT_TASKS).toContain('NAMED_ENTITY_RECOGNITION');
    expect(isAgentTask('NAMED_ENTITY_RECOGNITION')).toBe(true);
  });

  it('is backed by a TOKEN_CLASSIFICATION registry row, and by no provider service', () => {
    expect(AGENT_TASK_MODEL_TASK_TYPE.NAMED_ENTITY_RECOGNITION).toBe('TOKEN_CLASSIFICATION');
    // Token classification is served by `apps/nlp`, which is not one of the three
    // `AiProviderConnection.service` values — so there is no BYO credential tier for it.
    expect(AGENT_TASK_SERVICE.NAMED_ENTITY_RECOGNITION).toBeNull();
  });

  // TASK-983 OD-6 — the former `AGENT_PROTOCOLS.NAMED_ENTITY_RECOGNITION` assertion is REMOVED
  // along with the constant. NER's one-shot posture is enforced in `AgentController.invokeNer`
  // (`?mode=stream` → 400 `MODE_UNSUPPORTED`), not by anything in this package.

  it('declares the §2.3 IO defaults', () => {
    const { inputSchema, outputSchema } = AGENT_IO_DEFAULTS.NAMED_ENTITY_RECOGNITION;
    expect(inputSchema).toMatchObject({
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: { text: { type: 'string' }, language: { type: 'string' } },
    });
    expect(outputSchema).toMatchObject({ type: 'object', required: ['entities'], additionalProperties: false });
    const entity = (outputSchema.properties as Record<string, { items: Record<string, unknown> }>).entities.items;
    expect(entity).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['text', 'label', 'start', 'end'],
      properties: {
        text: { type: 'string' },
        label: { type: 'string' },
        start: { type: 'integer' },
        end: { type: 'integer' },
        score: { type: 'number' },
      },
    });
  });

  it('allows exactly `labels` in the instruction and exactly `threshold` / `aggregation` in the parameters', () => {
    const instruction = AGENT_INSTRUCTION_SCHEMAS.NAMED_ENTITY_RECOGNITION;
    expect(instruction).not.toBeNull();
    expect(Object.keys((instruction?.properties as object) ?? {})).toEqual(['labels']);
    expect(instruction?.additionalProperties).toBe(false);

    const parameters = AGENT_PARAMETER_SCHEMAS.NAMED_ENTITY_RECOGNITION;
    expect(Object.keys((parameters.properties as object) ?? {}).sort()).toEqual(['aggregation', 'threshold']);
    expect(parameters.additionalProperties).toBe(false);
    expect((parameters.properties as Record<string, Record<string, unknown>>).aggregation.enum).toEqual(['simple', 'first', 'max', 'average']);
  });

  it('accepts a label set and refuses every other instruction key, like TTS', () => {
    expect(agentConfigProblems({ task: 'NAMED_ENTITY_RECOGNITION', instruction: { labels: ['CONDITION'] } }, { model: nerModel })).toEqual([]);

    const stray = agentConfigProblems({ task: 'NAMED_ENTITY_RECOGNITION', instruction: { systemPrompt: 'summarise' } }, { model: nerModel });
    expect(hasBlockingAgentProblems(stray)).toBe(true);
    expect(stray[0]?.path).toBe('instruction');
    expect(stray[0]?.message).toContain('systemPrompt');
  });

  it('refuses tool bindings and a model of the wrong registry task type', () => {
    const withTools = agentConfigProblems({ task: 'NAMED_ENTITY_RECOGNITION', tools: [{ kind: 'mcp' }] }, { model: nerModel });
    expect(withTools.some((problem) => problem.path === 'tools')).toBe(true);

    const wrongModel = agentConfigProblems(
      { task: 'NAMED_ENTITY_RECOGNITION' },
      { model: { slug: 'lms-gemma-4-e2b-it-qat', taskType: 'TEXT_GENERATION' } },
    );
    expect(wrongModel[0]).toMatchObject({ severity: 'ERROR', path: 'modelId' });
    expect(wrongModel[0]?.message).toContain('TOKEN_CLASSIFICATION');
  });
});

describe('TASK-930 §5 — outputSchemaResponseFormat', () => {
  const declared = {
    type: 'object',
    additionalProperties: false,
    required: ['case_note'],
    properties: { case_note: { type: 'string' } },
  };

  it('is undefined when the declared output is the task default', () => {
    expect(outputSchemaResponseFormat('casenote-finalization', AGENT_IO_DEFAULTS.TEXT_GENERATION.outputSchema, null)).toBeUndefined();
  });

  it('is undefined when the declared output is absent or not an object schema with properties', () => {
    expect(outputSchemaResponseFormat('a', undefined, null)).toBeUndefined();
    expect(outputSchemaResponseFormat('a', null, null)).toBeUndefined();
    expect(outputSchemaResponseFormat('a', { type: 'string' }, null)).toBeUndefined();
    expect(outputSchemaResponseFormat('a', { type: 'object', properties: {} }, null)).toBeUndefined();
  });

  it('emits a strict json_schema response format named after the slug', () => {
    expect(outputSchemaResponseFormat('casenote-finalization', declared, {})).toEqual({
      type: 'json_schema',
      json_schema: { name: 'casenote_finalization_output', schema: declared, strict: true },
    });
  });

  it('sanitises every character the engine`s schema name grammar does not accept', () => {
    expect(outputSchemaResponseFormat('arcaai/gen.summary v2', declared, null)?.json_schema.name).toBe('arcaai_gen_summary_v2_output');
  });

  it('yields to an explicit `parameters.responseFormat` — the hyper-parameter always wins', () => {
    expect(outputSchemaResponseFormat('casenote-finalization', declared, { responseFormat: 'json_object' })).toBeUndefined();
    expect(outputSchemaResponseFormat('casenote-finalization', declared, { responseFormat: 'json_schema', responseSchema: declared })).toBeUndefined();
  });
});

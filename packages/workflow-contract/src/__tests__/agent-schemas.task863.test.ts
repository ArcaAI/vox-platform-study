/**
 * TASK-863 step 3 — the Agent entity's task-specific configuration contract.
 *
 * An Agent performs exactly ONE task (`SPEECH_TO_TEXT` | `TEXT_GENERATION` | `TEXT_TO_SPEECH`)
 * and its `parameters` / `instruction` / I/O schemas are typed per task. These tests are the
 * golden pass/fail fixtures per task; the applications layer runs `jsonSchemaValueProblems`
 * over `AGENT_PARAMETER_SCHEMAS[task]` and `agentConfigProblems` for what a JSON Schema cannot
 * express (task/model match, forbidden keys, instruction shape, capability gates).
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_IO_DEFAULTS,
  AGENT_PARAMETER_SCHEMAS,
  AGENT_PROTOCOLS,
  AGENT_TASKS,
  AGENT_TASK_MODEL_TASK_TYPE,
  AGENT_TASK_SERVICE,
  agentConfigProblems,
  hasBlockingAgentProblems,
} from '../agent-schemas';
import { forbiddenSchemaKeyProblems } from '../agentic-contract';

const MODEL_LLM = { slug: 'lms-gemma-4-e2b-it-qat', taskType: 'TEXT_GENERATION', provider: 'lmstudio' };
const MODEL_ASR = { slug: 'arcaai-whisper-large-ml-en-gguf', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'local' };
const MODEL_TTS = { slug: 'kokoro', taskType: 'TEXT_TO_SPEECH', provider: 'local' };

describe('TASK-863 — task taxonomy', () => {
  it('names exactly the three owner-directed tasks, mapped to a service and a registry task type', () => {
    expect([...AGENT_TASKS]).toEqual(['SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_TO_SPEECH']);
    expect(AGENT_TASK_SERVICE).toEqual({ SPEECH_TO_TEXT: 'stt', TEXT_GENERATION: 'llm', TEXT_TO_SPEECH: 'tts' });
    expect(AGENT_TASK_MODEL_TASK_TYPE).toEqual({
      SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
      TEXT_GENERATION: 'TEXT_GENERATION',
      TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
    });
  });

  it('declares a parameter schema, I/O defaults and protocols for every task', () => {
    for (const task of AGENT_TASKS) {
      expect(AGENT_PARAMETER_SCHEMAS[task]).toMatchObject({ type: 'object', additionalProperties: false });
      expect(AGENT_IO_DEFAULTS[task].inputSchema).toMatchObject({ type: 'object' });
      expect(AGENT_IO_DEFAULTS[task].outputSchema).toMatchObject({ type: 'object' });
      expect(AGENT_PROTOCOLS[task].length).toBeGreaterThan(0);
      expect(AGENT_PROTOCOLS[task]).toContain('http');
    }
    expect(AGENT_PROTOCOLS.SPEECH_TO_TEXT).toContain('socket');
    expect(AGENT_PROTOCOLS.TEXT_GENERATION).toContain('http-sse');
  });

  it('declares no property that could carry a credential, endpoint or wire model id (reference-only rule)', () => {
    // The same DIRECTION 1 scan the workflow node catalogue is held to — an agent inherits it.
    expect(forbiddenSchemaKeyProblems(AGENT_PARAMETER_SCHEMAS)).toEqual([]);
  });
});

describe('TASK-863 — TEXT_GENERATION', () => {
  const base = {
    task: 'TEXT_GENERATION' as const,
    instruction: { promptTemplateId: '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b41', promptVersionNumber: 2 },
    parameters: { generation: { temperature: 0.2, maxTokens: 1024 }, responseFormat: 'text' },
  };

  it('accepts a template-bound agent on a TEXT_GENERATION model', () => {
    expect(agentConfigProblems(base, { model: MODEL_LLM })).toEqual([]);
  });

  it('accepts an inline system prompt instead of a template', () => {
    expect(agentConfigProblems({ ...base, instruction: { systemPrompt: 'You are a clinical scribe.' } }, { model: MODEL_LLM })).toEqual([]);
  });

  it('refuses an instruction that names BOTH a template and a system prompt, and one that names neither', () => {
    const both = agentConfigProblems({ ...base, instruction: { ...base.instruction, systemPrompt: 'x' } }, { model: MODEL_LLM });
    expect(both.some((p) => p.severity === 'ERROR' && /exactly one/i.test(p.message))).toBe(true);
    const neither = agentConfigProblems({ ...base, instruction: {} }, { model: MODEL_LLM });
    expect(neither.some((p) => p.severity === 'ERROR')).toBe(true);
  });

  it('refuses a model of another task type (a TEXT_GENERATION agent on an ASR model)', () => {
    const problems = agentConfigProblems(base, { model: MODEL_ASR });
    expect(problems.some((p) => p.severity === 'ERROR' && p.message.includes('AUTOMATIC_SPEECH_RECOGNITION'))).toBe(true);
  });

  it('refuses a fallback model whose task type differs from the agent task', () => {
    const problems = agentConfigProblems(base, { model: MODEL_LLM, fallbackModels: [MODEL_TTS] });
    expect(problems.some((p) => p.severity === 'ERROR' && p.path === 'fallbacks[0]')).toBe(true);
  });

  it('requires a responseSchema when responseFormat is json_schema', () => {
    const problems = agentConfigProblems({ ...base, parameters: { ...base.parameters, responseFormat: 'json_schema' } }, { model: MODEL_LLM });
    expect(problems.some((p) => p.severity === 'ERROR' && p.path === 'parameters.responseSchema')).toBe(true);
    expect(
      agentConfigProblems(
        { ...base, parameters: { ...base.parameters, responseFormat: 'json_schema', responseSchema: { type: 'object' } } },
        { model: MODEL_LLM },
      ),
    ).toEqual([]);
  });

  it('gates hyper-parameters against the bound provider capabilities (ERROR when declared-unsupported, WARNING when unknown)', () => {
    const declared = agentConfigProblems(
      { ...base, parameters: { generation: { temperature: 0.2, presencePenalty: 0.5 } } },
      { model: MODEL_LLM, capabilities: { supportedGenerationParams: ['temperature'], label: 'lmstudio/gemma' } },
    );
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ severity: 'ERROR', path: 'parameters.generation.presencePenalty' });
    expect(hasBlockingAgentProblems(declared)).toBe(true);

    const unknown = agentConfigProblems({ ...base, parameters: { generation: { presencePenalty: 0.5 } } }, { model: MODEL_LLM, capabilities: { label: 'x' } });
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe('WARNING');
    expect(hasBlockingAgentProblems(unknown)).toBe(false);
  });

  it('refuses a forbidden key anywhere in parameters, instruction or tools (reference-only rule)', () => {
    const problems = agentConfigProblems(
      { ...base, parameters: { ...base.parameters, generation: { temperature: 0.1, endpoint: 'http://x' } } },
      { model: MODEL_LLM },
    );
    expect(problems.some((p) => p.severity === 'ERROR' && p.path === 'parameters.generation.endpoint')).toBe(true);
    const inInstruction = agentConfigProblems({ ...base, instruction: { systemPrompt: 'x', apiKey: 'sk-1' } }, { model: MODEL_LLM });
    expect(inInstruction.some((p) => p.path === 'instruction.apiKey')).toBe(true);
  });

  it('accepts tool bindings as (mcpServerId, toolName) references', () => {
    expect(
      agentConfigProblems({ ...base, tools: [{ mcpServerId: '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b41', toolName: 'fhir.lookup' }] }, { model: MODEL_LLM }),
    ).toEqual([]);
  });
});

describe('TASK-863 — SPEECH_TO_TEXT', () => {
  const base = {
    task: 'SPEECH_TO_TEXT' as const,
    instruction: { initialPrompt: 'Clinical consultation in English and Malayalam.', hotwords: ['metformin'] },
    parameters: {
      audioFrontEnd: { vad: { modelSlug: 'silero-vad', threshold: 0.5 }, diarization: { enabled: false } },
      decoding: { languageMode: 'ml-en', wordTimestamps: true, beamSize: 5 },
      streaming: { partialIntervalMs: 500, endpointing: 'semantic' },
      fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 3 },
    },
  };

  it('accepts the ASR spec of TASK-861 §3.2 on an ASR model', () => {
    expect(agentConfigProblems(base, { model: MODEL_ASR })).toEqual([]);
  });

  it('refuses tools on a non-generation agent', () => {
    const problems = agentConfigProblems({ ...base, tools: [{ mcpServerId: 'x', toolName: 'y' }] }, { model: MODEL_ASR });
    expect(problems.some((p) => p.severity === 'ERROR' && p.path === 'tools')).toBe(true);
  });

  it('refuses a TEXT_GENERATION-shaped instruction on an ASR agent', () => {
    const problems = agentConfigProblems({ ...base, instruction: { systemPrompt: 'x' } }, { model: MODEL_ASR });
    expect(problems.some((p) => p.severity === 'ERROR' && p.path === 'instruction')).toBe(true);
  });

  it('the parameter schema references every auxiliary model by registry SLUG, never an engine name', () => {
    const schema = JSON.stringify(AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT);
    expect(schema).toContain('modelSlug');
    expect(schema).not.toMatch(/"engine"|"provider"/);
  });
});

describe('TASK-863 — TEXT_TO_SPEECH', () => {
  const base = {
    task: 'TEXT_TO_SPEECH' as const,
    parameters: { voice: 'af_heart', language: 'en', speed: 1, format: 'wav', sampleRate: 24000 },
  };

  it('accepts a voice selection on a TTS model with no instruction', () => {
    expect(agentConfigProblems(base, { model: MODEL_TTS })).toEqual([]);
  });

  it('refuses an instruction (TTS agents carry none)', () => {
    const problems = agentConfigProblems({ ...base, instruction: { systemPrompt: 'x' } }, { model: MODEL_TTS });
    expect(problems.some((p) => p.severity === 'ERROR' && p.path === 'instruction')).toBe(true);
  });

  it('refuses ssml unless the bound provider declares it (capability-gated)', () => {
    const refused = agentConfigProblems({ ...base, parameters: { ...base.parameters, ssml: true } }, { model: MODEL_TTS, capabilities: { supportsSsml: false } });
    expect(refused.some((p) => p.severity === 'ERROR' && p.path === 'parameters.ssml')).toBe(true);
    expect(agentConfigProblems({ ...base, parameters: { ...base.parameters, ssml: true } }, { model: MODEL_TTS, capabilities: { supportsSsml: true } })).toEqual([]);
    // Unknown capability set → warning, same posture as generation hyper-parameters.
    const unknown = agentConfigProblems({ ...base, parameters: { ...base.parameters, ssml: true } }, { model: MODEL_TTS, capabilities: { label: 'kokoro' } });
    expect(unknown.some((p) => p.severity === 'WARNING' && p.path === 'parameters.ssml')).toBe(true);
  });
});

describe('TASK-863 — without a model context', () => {
  it('still reports the within-config problems and skips only the model checks', () => {
    expect(agentConfigProblems({ task: 'TEXT_GENERATION', instruction: { systemPrompt: 'x' } })).toEqual([]);
    expect(agentConfigProblems({ task: 'NOT_A_TASK' as never })).toHaveLength(1);
  });
});

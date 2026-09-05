/**
 * TASK-863 §3.7 — the first-class Agents: platform defaults (SYSTEM tenant) and the
 * Global-tenant examples.
 *
 * SYSTEM tenant (`isActive: true`, PUBLISHED) — the platform defaults every tenant inherits
 * through the assignment cascade (`AgentAssignment` TENANT rows on the SYSTEM tenant are the
 * cascade's last tier):
 *   platform-transcription        SPEECH_TO_TEXT   arcaai-whisper-large-ml-en-gguf (+ faster-whisper CT2 fallback, silero-vad, cadence punctuation)
 *   platform-summarization        TEXT_GENERATION  elected text model + the APPROVED live SOAP template
 *   platform-presummarization     TEXT_GENERATION  + the APPROVED pre-summary default template
 *   platform-discharge-summary    TEXT_GENERATION  + an inline system prompt (no APPROVED SYSTEM discharge template exists on this base)
 *   platform-grammar-correction   TEXT_GENERATION  + the APPROVED live transcript-corrections template
 *   platform-important-findings   TEXT_GENERATION  + the APPROVED important-findings template, JSON output
 *   platform-tts                  TEXT_TO_SPEECH   kokoro / af_heart
 *
 * Global tenant (`50000000-…`, the platform-admin PLAYGROUND — a customer tenant, never a
 * config tier): the same set as PUBLISHED `example-*` rows, plus one Azure-backed and one
 * Sarvam-backed ASR agent in DRAFT (no key is seeded; publish fails closed until a provider
 * connection exists — the ticket's own fail-closed proof). ArcaAI tenant: nothing
 * (provisioning clones SYSTEM — owner ruling 2026-08-20).
 *
 * Rows are written directly (unscoped client, create-only): a PUBLISHED Agent is immutable at
 * the service AND at the `agent_immutability_guard` trigger, so an upsert with an `update`
 * branch would raise at the DB. Model rows are resolved BY SLUG at seed time (never a hard-coded
 * model id): the registry seed (TASK-860) owns those ids. A spec whose model or template is
 * missing is SKIPPED with a warning rather than seeded broken — the same fail-closed posture
 * `AgentService.publish` takes.
 *
 * `compiledConfig` mirrors `AgentService.compile` (`AgentCompiledConfig` in @arcaai/types) and
 * its checksum is `sha256:` over the same canonical JSON (`canonicalJson` in
 * @arcaai/workflow-contract — duplicated here because @arcaai/database takes no dependency on
 * the contract package; `task-863-agents.test.ts` pins the parity).
 */
import { createHash } from 'node:crypto';
import type { CorePrismaClient } from '../../../client';
import { SEED_TENANT_ID, SYSTEM_LIVE_SOAP_TEMPLATE_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { TEMPLATE_IDS } from './07-prompt-template';

export const COMPILED_AT = '2026-09-04T00:00:00.000Z';

export type SeedAgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH';

export const AGENT_TASK_SERVICE: Record<SeedAgentTask, 'stt' | 'llm' | 'tts'> = { SPEECH_TO_TEXT: 'stt', TEXT_GENERATION: 'llm', TEXT_TO_SPEECH: 'tts' };
export const AGENT_TASK_MODEL_TASK_TYPE: Record<SeedAgentTask, string> = {
  SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
};
const AGENT_PROTOCOLS: Record<SeedAgentTask, string[]> = { SPEECH_TO_TEXT: ['http', 'socket'], TEXT_GENERATION: ['http', 'http-sse'], TEXT_TO_SPEECH: ['http', 'http-sse'] };

/** The task defaults of AGENT_IO_DEFAULTS, compiled verbatim so the runtime never reads a null schema. */
const IO_DEFAULTS: Record<SeedAgentTask, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
  TEXT_GENERATION: {
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1 }, variables: { type: 'object', additionalProperties: { type: 'string' } } } },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  },
  SPEECH_TO_TEXT: {
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['audio'],
      properties: {
        audio: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['artifact', 'stream'] }, mediaId: { type: 'string' }, sessionId: { type: 'string' } } },
        language: { type: 'string', minLength: 2, maxLength: 16 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['transcript'],
      properties: {
        transcript: { type: 'array', items: { type: 'object', required: ['text', 'start', 'end'], properties: { text: { type: 'string' }, start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, speaker: { type: 'string' }, isFinal: { type: 'boolean' } } } },
        language: { type: 'string' },
      },
    },
  },
  TEXT_TO_SPEECH: {
    inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, ssml: { type: 'string', minLength: 1, maxLength: 40000 } }, anyOf: [{ required: ['text'] }, { required: ['ssml'] }] },
    outputSchema: { type: 'object', required: ['audio'], properties: { audio: { type: 'object', required: ['mediaId', 'format'], properties: { mediaId: { type: 'string' }, format: { type: 'string' }, sampleRate: { type: 'integer' } } }, durationMs: { type: 'integer', minimum: 0 } } },
  },
};

export interface SeedAgentSpec {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  task: SeedAgentTask;
  modelSlug: string;
  fallbackModelSlugs: string[];
  instruction: Record<string, unknown> | null;
  parameters: Record<string, unknown>;
  status: 'PUBLISHED' | 'DRAFT';
  isActive: boolean;
  tags: string[];
}

/** Id blocks: `9c000000-…-0001-` SYSTEM agents, `-0002-` Global agents, `-0003-` fallbacks, `-0004-` assignments. */
const sys = (n: number) => `9c000000-0000-0000-0001-${String(n).padStart(12, '0')}`;
const glob = (n: number) => `9c000000-0000-0000-0002-${String(n).padStart(12, '0')}`;
export const fallbackId = (n: number) => `9c000000-0000-0000-0003-${String(n).padStart(12, '0')}`;
export const assignmentId = (n: number) => `9c000000-0000-0000-0004-${String(n).padStart(12, '0')}`;

const ASR_PARAMETERS = {
  audioFrontEnd: { vad: { modelSlug: 'silero-vad', threshold: 0.5, minSpeechMs: 250, minSilenceMs: 500 }, diarization: { enabled: false, backend: 'embedding', embeddingModelSlug: 'wespeaker-voxceleb-resnet34', maxSpeakers: 2, matchThreshold: 0.6 } },
  decoding: { languageMode: 'ml-en', codeSwitching: true, wordTimestamps: true, beamSize: 5, temperature: 0 },
  postProcessing: { punctuation: { enabled: true, modelSlug: 'cadence-punctuation' }, disfluency: true, stabilizer: true },
  streaming: { partialIntervalMs: 500, endpointing: 'semantic', maxUtteranceSec: 60 },
  fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 3 },
};
const ASR_INSTRUCTION = { initialPrompt: 'Clinical consultation between a clinician and a patient. English and Malayalam medical terminology.', hotwords: [] as string[] };

const DISCHARGE_SYSTEM_PROMPT =
  'You are a clinical documentation assistant. From the consultation transcript and the clinician notes provided, draft a discharge summary with these sections: Admission diagnosis, Hospital course, Procedures, Discharge diagnosis, Discharge medications, Follow-up, Patient instructions. Use only facts present in the input; mark anything uncertain as "to be confirmed by the clinician". Never invent findings, doses or dates.';

/** The platform defaults + the Global examples, as pure data. */
function catalogue(tenantId: string, prefix: 'platform' | 'example', ids: (n: number) => string, published: boolean): SeedAgentSpec[] {
  const status = published ? 'PUBLISHED' : 'DRAFT';
  // TASK-884 — agent tags are `key:value` pairs (owner decision #6): the grammar the write
  // DTOs now enforce, so the platform's own rows are what a tenant admin copies. A bare tag
  // like `stt` has no key, which is exactly the ungrouped vocabulary the pair form prevents.
  const tier = prefix === 'platform' ? 'tier:platform-default' : 'tier:example';
  return [
    {
      id: ids(1),
      tenantId,
      slug: `${prefix}-transcription`,
      name: prefix === 'platform' ? 'Platform transcription (whisper.cpp ML/EN)' : 'Example transcription (whisper.cpp ML/EN)',
      description: 'Realtime + batch speech-to-text on the in-house Malayalam/English whisper.cpp GGUF, Silero VAD gating, Cadence punctuation, CTranslate2 turbo as the fallback.',
      task: 'SPEECH_TO_TEXT',
      modelSlug: 'arcaai-whisper-large-ml-en-gguf',
      fallbackModelSlugs: ['faster-whisper-large-v3-turbo-int8'],
      instruction: ASR_INSTRUCTION,
      parameters: ASR_PARAMETERS,
      status,
      isActive: published,
      tags: [tier, 'task:stt', 'capability:transcription'],
    },
    {
      id: ids(2),
      tenantId,
      slug: `${prefix}-summarization`,
      name: prefix === 'platform' ? 'Platform summarization (SOAP)' : 'Example summarization (SOAP)',
      description: 'Consultation SOAP summary on the elected platform text model, bound to the approved live SOAP template.',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { promptTemplateId: SYSTEM_LIVE_SOAP_TEMPLATE_ID, promptVersionNumber: 1 },
      parameters: { generation: { temperature: 0.2, maxTokens: 2048 }, responseFormat: 'text' },
      status,
      isActive: published,
      tags: [tier, 'task:llm', 'capability:summarization'],
    },
    {
      id: ids(3),
      tenantId,
      slug: `${prefix}-presummarization`,
      name: prefix === 'platform' ? 'Platform pre-summarization' : 'Example pre-summarization',
      description: 'Pre-visit summary from prior context, bound to the approved pre-summary default template.',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { promptTemplateId: TEMPLATE_IDS.PRE_SUMMARY_DEFAULT, promptVersionNumber: 1 },
      parameters: { generation: { temperature: 0.2, maxTokens: 1536 }, responseFormat: 'text' },
      status,
      isActive: published,
      tags: [tier, 'task:llm', 'capability:presummarization'],
    },
    {
      id: ids(4),
      tenantId,
      slug: `${prefix}-discharge-summary`,
      name: prefix === 'platform' ? 'Platform discharge summary' : 'Example discharge summary',
      description: 'Discharge summary drafting with an inline system prompt (no approved platform discharge template exists yet — bind one when it does).',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { systemPrompt: DISCHARGE_SYSTEM_PROMPT },
      parameters: { generation: { temperature: 0.1, maxTokens: 3072 }, responseFormat: 'text' },
      status,
      isActive: published,
      tags: [tier, 'task:llm', 'capability:discharge-summary'],
    },
    {
      id: ids(5),
      tenantId,
      slug: `${prefix}-grammar-correction`,
      name: prefix === 'platform' ? 'Platform transcript corrections' : 'Example transcript corrections',
      description: 'Live transcript grammar/spelling corrections, bound to the approved corrections template; deterministic decoding.',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { promptTemplateId: TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM, promptVersionNumber: 1 },
      parameters: { generation: { temperature: 0, maxTokens: 1024 }, responseFormat: 'text' },
      status,
      isActive: published,
      tags: [tier, 'task:llm', 'capability:grammar'],
    },
    {
      id: ids(6),
      tenantId,
      slug: `${prefix}-important-findings`,
      name: prefix === 'platform' ? 'Platform important findings' : 'Example important findings',
      description: 'Important-findings extraction as JSON, bound to the approved important-findings template.',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { promptTemplateId: TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM, promptVersionNumber: 1 },
      parameters: { generation: { temperature: 0, maxTokens: 1024 }, responseFormat: 'json' },
      status,
      isActive: published,
      tags: [tier, 'task:llm', 'capability:important-findings'],
    },
    {
      id: ids(7),
      tenantId,
      slug: `${prefix}-tts`,
      name: prefix === 'platform' ? 'Platform text-to-speech (Kokoro)' : 'Example text-to-speech (Kokoro)',
      description: 'English speech synthesis on the local Kokoro engine, voice af_heart, 24 kHz WAV.',
      task: 'TEXT_TO_SPEECH',
      modelSlug: 'kokoro',
      fallbackModelSlugs: [],
      instruction: null,
      parameters: { voice: 'af_heart', language: 'en', speed: 1, format: 'wav', sampleRate: 24000 },
      status,
      isActive: published,
      tags: [tier, 'task:tts'],
    },
  ];
}

export const PLATFORM_AGENT_SPECS: SeedAgentSpec[] = catalogue(SYSTEM_TENANT_ID, 'platform', sys, true);

export const GLOBAL_AGENT_SPECS: SeedAgentSpec[] = [
  ...catalogue(SEED_TENANT_ID, 'example', glob, true),
  {
    id: glob(8),
    tenantId: SEED_TENANT_ID,
    slug: 'example-azure-transcription',
    name: 'Example transcription (Azure Speech) — draft',
    description: 'Cloud ASR on Azure Speech. DRAFT: publish fails closed until an enabled stt/azure provider connection exists (no key is seeded).',
    task: 'SPEECH_TO_TEXT',
    modelSlug: 'azure-speech-stt',
    fallbackModelSlugs: ['arcaai-whisper-large-ml-en-gguf'],
    instruction: { initialPrompt: ASR_INSTRUCTION.initialPrompt },
    parameters: { decoding: { languageMode: 'en', wordTimestamps: true }, streaming: { partialIntervalMs: 500, endpointing: 'fixed' }, fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 2 } },
    status: 'DRAFT',
    isActive: false,
    tags: ['tier:example', 'task:stt', 'provider:azure', 'hosting:cloud'],
  },
  {
    // The e2e LIVE-SESSION fixture agent. PUBLISHED + active so a spec can name
    // it with `agentSlug`, but never assigned to any tenant — the SYSTEM
    // cascade is untouched, so nothing resolves it implicitly.
    //
    // Two deliberate differences from `example-transcription`:
    //   - `whisper-large-v3-turbo-q8_0`, the PUBLIC GGUF (`audio.ts`), because
    //     the in-house fine-tunes live in a private Hub repo the test stack has
    //     no token for.
    //   - NO fallback. `faster-whisper-large-v3-turbo-int8` is a CTranslate2
    //     download; letting a failed primary silently pull ~1.5 GB inside the
    //     gateway's 15s session-create budget turns a model problem into a
    //     timeout that reads as "STT is down". Failing fast names the cause.
    id: glob(10),
    tenantId: SEED_TENANT_ID,
    slug: 'example-transcription-turbo',
    name: 'Example transcription (whisper.cpp turbo q8_0, public)',
    description: 'Realtime + batch speech-to-text on the public whisper.cpp GGUF turbo q8_0. The credential-free fixture the e2e live-session specs name explicitly.',
    task: 'SPEECH_TO_TEXT',
    modelSlug: 'whisper-large-v3-turbo-q8_0',
    fallbackModelSlugs: [],
    instruction: ASR_INSTRUCTION,
    parameters: ASR_PARAMETERS,
    status: 'PUBLISHED',
    isActive: true,
    tags: ['tier:example', 'task:stt', 'capability:transcription', 'fixture:e2e'],
  },
  {
    id: glob(9),
    tenantId: SEED_TENANT_ID,
    slug: 'example-sarvam-transcription',
    name: 'Example transcription (Sarvam Saaras) — draft',
    description: 'Cloud ASR on Sarvam Saaras for Indic languages. DRAFT: publish fails closed until an enabled stt/sarvam provider connection exists (no key is seeded).',
    task: 'SPEECH_TO_TEXT',
    modelSlug: 'sarvam-saaras-v4',
    fallbackModelSlugs: ['arcaai-whisper-large-ml-en-gguf'],
    instruction: null,
    parameters: { decoding: { languageMode: 'ml-en', codeSwitching: true }, streaming: { partialIntervalMs: 500, endpointing: 'fixed' } },
    status: 'DRAFT',
    isActive: false,
    tags: ['tier:example', 'task:stt', 'provider:sarvam', 'hosting:cloud'],
  },
];

/** SYSTEM TENANT-scope assignments — the platform default per task (the cascade's last tier). */
export const PLATFORM_AGENT_ASSIGNMENTS: Array<{ id: string; task: SeedAgentTask; agentSlug: string }> = [
  { id: assignmentId(1), task: 'SPEECH_TO_TEXT', agentSlug: 'platform-transcription' },
  { id: assignmentId(2), task: 'TEXT_GENERATION', agentSlug: 'platform-summarization' },
  { id: assignmentId(3), task: 'TEXT_TO_SPEECH', agentSlug: 'platform-tts' },
];

// ----------------------------------------------------------------------------------------------
// Row building (pure)
// ----------------------------------------------------------------------------------------------

export interface SeedModelRef {
  id: string;
  slug: string;
  taskType: string;
  provider: string | null;
}

export type SeedResolvedPrompt =
  | { source: 'template'; promptTemplateId: string; promptVersionNumber: number; content: string }
  | { source: 'inline'; content: string }
  | null;

/** `canonicalJson` of @arcaai/workflow-contract, verbatim (sorted keys, `undefined` dropped, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function buildCompiledConfig(spec: SeedAgentSpec, model: SeedModelRef, fallbacks: SeedModelRef[], resolvedPrompt: SeedResolvedPrompt): Record<string, unknown> {
  return {
    task: spec.task,
    service: AGENT_TASK_SERVICE[spec.task],
    model: { id: model.id, slug: model.slug, provider: model.provider ?? null, taskType: model.taskType },
    fallbacks: fallbacks.map((fallback, priority) => ({ priority, id: fallback.id, slug: fallback.slug, provider: fallback.provider ?? null })),
    instruction: spec.instruction,
    resolvedPrompt,
    parameters: spec.parameters,
    inputSchema: IO_DEFAULTS[spec.task].inputSchema,
    outputSchema: IO_DEFAULTS[spec.task].outputSchema,
    tools: [],
    protocols: AGENT_PROTOCOLS[spec.task],
  };
}

export function checksumOf(compiled: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(compiled)).digest('hex')}`;
}

/** The `agent.create` data for one spec. PUBLISHED rows carry a compiledConfig; DRAFT rows do not. */
export function buildAgentRow(spec: SeedAgentSpec, model: SeedModelRef, fallbacks: SeedModelRef[], resolvedPrompt: SeedResolvedPrompt) {
  const published = spec.status === 'PUBLISHED';
  const compiled = published ? buildCompiledConfig(spec, model, fallbacks, resolvedPrompt) : null;
  return {
    id: spec.id,
    tenantId: spec.tenantId,
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    task: spec.task,
    versionNumber: 1,
    parentVersionId: null,
    status: spec.status,
    isActive: spec.isActive,
    modelId: model.id,
    instruction: spec.instruction,
    parameters: spec.parameters,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: compiled,
    compiledConfigChecksum: compiled ? checksumOf(compiled) : null,
    validationReport: published ? { checkedAt: COMPILED_AT, blocking: false, findings: [] } : null,
    validatedAt: published ? new Date(COMPILED_AT) : null,
    publishedAt: published ? new Date(COMPILED_AT) : null,
    tags: spec.tags,
    createdBy: SYSTEM_USER_ID,
  };
}

// ----------------------------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------------------------

export interface SeedAgentsResult {
  created: number;
  skippedExisting: number;
  skippedUnresolvable: number;
  assignmentsCreated: number;
}

/** The slice of the Prisma client the seed touches — typed narrowly so the test can hand in a fake. */
export interface SeedAgentsClient {
  aiModel: { findMany(args: { where: { tenantId: string } }): Promise<Array<{ id: string; slug: string; taskType: string; provider: string | null }>> };
  promptTemplate: { findUnique(args: { where: { id: string } }): Promise<{ id: string; status: string | null; content: string | null; approvedVersionNumber: number | null; currentVersionNumber: number | null } | null> };
  promptVersion: { findFirst(args: { where: { promptTemplateId: string; versionNumber: number } }): Promise<{ content: string | null } | null> };
  agent: { findUnique(args: { where: { id: string }; select?: { id: true } }): Promise<{ id: string } | null>; create(args: { data: unknown }): Promise<unknown> };
  agentModelFallback: { create(args: { data: unknown }): Promise<unknown> };
  agentAssignment: { findUnique(args: { where: { id: string }; select?: { id: true } }): Promise<{ id: string } | null>; create(args: { data: unknown }): Promise<unknown> };
}

async function resolvePrompt(client: SeedAgentsClient, spec: SeedAgentSpec): Promise<{ ok: true; resolvedPrompt: SeedResolvedPrompt } | { ok: false; reason: string }> {
  if (spec.task !== 'TEXT_GENERATION' || !spec.instruction) return { ok: true, resolvedPrompt: null };
  const systemPrompt = spec.instruction.systemPrompt;
  if (typeof systemPrompt === 'string') return { ok: true, resolvedPrompt: { source: 'inline', content: systemPrompt } };
  const templateId = spec.instruction.promptTemplateId;
  if (typeof templateId !== 'string') return { ok: true, resolvedPrompt: null };
  const template = await client.promptTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: `prompt template ${templateId} is not seeded` };
  if (template.status !== 'APPROVED') return { ok: false, reason: `prompt template ${templateId} is ${template.status ?? 'DRAFT'}, not APPROVED` };
  const versionNumber = typeof spec.instruction.promptVersionNumber === 'number' ? spec.instruction.promptVersionNumber : (template.approvedVersionNumber ?? template.currentVersionNumber ?? 1);
  const version = await client.promptVersion.findFirst({ where: { promptTemplateId: templateId, versionNumber } });
  return { ok: true, resolvedPrompt: { source: 'template', promptTemplateId: templateId, promptVersionNumber: versionNumber, content: version?.content ?? template.content ?? '' } };
}

export async function seedAgentSpecs(client: SeedAgentsClient, specs: SeedAgentSpec[], label: string): Promise<SeedAgentsResult> {
  console.log(`Seeding ${label} agents ...`);
  const result: SeedAgentsResult = { created: 0, skippedExisting: 0, skippedUnresolvable: 0, assignmentsCreated: 0 };
  const models = await client.aiModel.findMany({ where: { tenantId: SYSTEM_TENANT_ID } });
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  let fallbackSeq = specs === PLATFORM_AGENT_SPECS ? 1 : 100;

  for (const spec of specs) {
    const existing = await client.agent.findUnique({ where: { id: spec.id }, select: { id: true } });
    if (existing) {
      result.skippedExisting += 1;
      continue;
    }
    const model = bySlug.get(spec.modelSlug);
    if (!model) {
      console.warn(`  ! ${spec.slug}: model '${spec.modelSlug}' is not in the SYSTEM registry — skipped (seed the catalogue first)`);
      result.skippedUnresolvable += 1;
      continue;
    }
    if (model.taskType !== AGENT_TASK_MODEL_TASK_TYPE[spec.task]) {
      console.warn(`  ! ${spec.slug}: model '${spec.modelSlug}' is ${model.taskType}, not ${AGENT_TASK_MODEL_TASK_TYPE[spec.task]} — skipped`);
      result.skippedUnresolvable += 1;
      continue;
    }
    const fallbacks: SeedModelRef[] = [];
    let fallbackMissing = false;
    for (const slug of spec.fallbackModelSlugs) {
      const fallback = bySlug.get(slug);
      if (!fallback) {
        console.warn(`  ! ${spec.slug}: fallback model '${slug}' is not in the SYSTEM registry — skipped`);
        fallbackMissing = true;
        break;
      }
      fallbacks.push(fallback);
    }
    if (fallbackMissing) {
      result.skippedUnresolvable += 1;
      continue;
    }
    const prompt = await resolvePrompt(client, spec);
    if (!prompt.ok) {
      console.warn(`  ! ${spec.slug}: ${prompt.reason} — skipped (fail closed)`);
      result.skippedUnresolvable += 1;
      continue;
    }

    const row = buildAgentRow(spec, model, fallbacks, prompt.resolvedPrompt);
    await client.agent.create({ data: row });
    for (const [priority, fallback] of fallbacks.entries()) {
      await client.agentModelFallback.create({
        data: { id: fallbackId(fallbackSeq++), tenantId: spec.tenantId, agentId: spec.id, priority, modelId: fallback.id, enabled: true, createdBy: SYSTEM_USER_ID },
      });
    }
    result.created += 1;
    console.log(`  created ${spec.slug} (${spec.task}, ${spec.status}${spec.isActive ? ', isActive' : ''}, model ${model.slug})`);
  }
  return result;
}

export async function seedPlatformAgentAssignments(client: SeedAgentsClient): Promise<number> {
  let created = 0;
  for (const assignment of PLATFORM_AGENT_ASSIGNMENTS) {
    const existing = await client.agentAssignment.findUnique({ where: { id: assignment.id }, select: { id: true } });
    if (existing) continue;
    const agent = await client.agent.findUnique({ where: { id: PLATFORM_AGENT_SPECS.find((spec) => spec.slug === assignment.agentSlug)?.id ?? '' }, select: { id: true } });
    if (!agent) {
      console.warn(`  ! assignment ${assignment.task} → ${assignment.agentSlug}: the agent was not seeded — skipped`);
      continue;
    }
    await client.agentAssignment.create({
      data: { id: assignment.id, tenantId: SYSTEM_TENANT_ID, scope: 'TENANT', scopeId: null, task: assignment.task, agentSlug: assignment.agentSlug, createdBy: SYSTEM_USER_ID },
    });
    created += 1;
    console.log(`  assigned SYSTEM ${assignment.task} → ${assignment.agentSlug}`);
  }
  return created;
}

/** Platform defaults (SYSTEM) + Global-tenant examples + SYSTEM assignments. ArcaAI: nothing. */
export async function seedAgents(client: CorePrismaClient | SeedAgentsClient): Promise<SeedAgentsResult> {
  const typed = client as unknown as SeedAgentsClient;
  const platform = await seedAgentSpecs(typed, PLATFORM_AGENT_SPECS, 'platform default (SYSTEM tenant)');
  const assignments = await seedPlatformAgentAssignments(typed);
  const examples = await seedAgentSpecs(typed, GLOBAL_AGENT_SPECS, 'Global-tenant example');
  return {
    created: platform.created + examples.created,
    skippedExisting: platform.skippedExisting + examples.skippedExisting,
    skippedUnresolvable: platform.skippedUnresolvable + examples.skippedUnresolvable,
    assignmentsCreated: assignments,
  };
}

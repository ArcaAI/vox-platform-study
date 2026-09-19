export * from './dto';
export * from './IAgentService';
export * from './agent-findings';
export * from './platform-hidden-agents';
// TASK-991 OD-3 — the platform-managed parameter lock (the speaker-embedding space).
export * from './platform-managed-parameters';
// TASK-891 C1 (OD-4) — the per-agent reasoning posture: its shape, its write-time
// validation and its mapping onto `GenerateRequest.extra`.
export * from './agent-reasoning';
export * from './agent.dto.mapper';
export * from './agent.service';
export * from './agent-resolver.service';
export * from './text-generation-spec';
export * from './text-agent-resolver.service';
export * from './tts-spec';
export * from './tts-agent-resolver.service';
export * from './tts-agent-resolver.service.module';
export * from './agent-invocation.service';
export * from './agent-wire-model';
// TASK-983 R9 — what an invocation must supply: computed at publish, projected on the read,
// diffed at request time. One vocabulary, three readers.
export * from './agent-required-variables';
export * from './agent.service.module';

// The resolver contract shape lives in @arcaai/types; re-exported so apps/api needs no direct dependency on that package.
export type {
  ResolvedAgent,
  ResolvedTtsCandidate,
  ResolvedTtsSpec,
  TtsSpecConnection,
  TtsSpecModel,
  TtsSpecParameters,
  TtsVoiceBinding,
} from '@arcaai/types';
export { RESOLVED_TTS_SPEC_SCHEMA_VERSION, TTS_SPEC_MODEL_ROLES, TTS_SPEC_MODEL_TASK_TYPE } from '@arcaai/types';

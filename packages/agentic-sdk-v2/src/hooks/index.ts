/**
 * @arcaai/vox - Hooks
 */

// Session hook
export { useArcaSession, type UseArcaSessionReturn } from './useArcaSession';

// Main hook with all functionality
export { useArca, type UseArcaReturn, type UseArcaSession, type UseArcaAudio, type UseArcaContext, type UseArcaSummary } from './useArca';

// Focused domain hooks (REFACTOR-01)
export { useArcaAudio } from './useArcaAudio';
// Runtime audio-input discovery for device pickers. Provider-free.
export {
  useArcaDevices,
  type ArcaAudioDevice,
  type ArcaDevicePreference,
  type ArcaDevicePermission,
  type UseArcaDevicesReturn,
} from './useArcaDevices';
export { useArcaContext } from './useArcaContext';
export { useArcaSummary } from './useArcaSummary';
export { useArcaLiveSummary, type UseArcaLiveSummaryReturn, type LiveSummaryStreamStatus } from './useArcaLiveSummary';
export { useArcaLiveAssist, type UseArcaLiveAssistReturn, type LiveAssistStreamStatus } from './useArcaLiveAssist';
export { useArcaPipelines } from './useArcaPipelines';
export type { UseArcaPipelineControl } from './useArcaPipelines';

// Configuration hook
export { useArcaConfig, type UseArcaConfigReturn } from './useArcaConfig';

// Typed built-in role identifiers tuple. Re-exported directly from
// `core/constants` — the admin `useRoles` hook that used to carry it was
// removed under TASK-890 (OD-F/OD-K); this tuple itself is not admin-bearing.
export { USER_ROLES, type UserRole } from '../core/constants';

// Storage management hook
export { useStorage, type UseStorageReturn } from './useStorage';
export type { Bucket, StorageFile, StorageFileWithUrl } from './useStorage';

// Auth hook
export { useAuth, type UseAuthReturn } from './useAuth';

// Consultation job hook
export { useConsultationJob, type UseConsultationJobReturn } from './useConsultationJob';

// DNA writing-style sample ingest hook (TASK-974, business plane)
export { useDnaWritingStyle, type UseDnaWritingStyleReturn, type PollIngestJobOptions } from './useDnaWritingStyle';

// Consultation chain hook — full multi-hop parent/child tree
export { useConsultationChain, type UseConsultationChainReturn } from './useConsultationChain';

// Consultation context schema discovery
export { useConsultationSchema, type UseConsultationSchemaReturn } from './useConsultationSchema';
// which engine governs a consultation (the read side of OpenSessionInput.workflowDefinitionSlug).
export { useConsultationWorkflow, type UseConsultationWorkflowReturn } from './useConsultationWorkflow';
export { useSelectableConsultationWorkflows, type UseSelectableConsultationWorkflowsReturn } from './useSelectableConsultationWorkflows';
// TASK-865: which ASR Agents may be named at `audio.start({ agentSlug })` (replaces usePipelines for selection).
export { useSelectableAsrAgents, type UseSelectableAsrAgentsReturn } from './useSelectableAsrAgents';

// workflow INVOCATION: run a published workflow (optionally against a
// consultation), watch it live with a resumable stream, cancel it.
export {
  RESERVED_RUN_IDENTITY_KEYS,
  ReservedRunIdentityError,
  reservedRunIdentityKeysIn,
  useWorkflowRun,
  type StartWorkflowRunOptions,
  type UseWorkflowRunOptions,
  type UseWorkflowRunReturn,
} from './useWorkflowRun';

// TASK-890: release a `core.humanReview` node — the durable wait a run parks on.
export { useWorkflowReview, type UseWorkflowReviewReturn } from './useWorkflowReview';

// TASK-890 (OD-F): invoke a PUBLISHED agent from the browser (blocking JSON or SSE).
// Business plane only — authoring/publishing agents is `@arcaai/vox-node`'s `hope.admin.*`.
export { useAgentInvocation, type UseAgentInvocationReturn } from './useAgentInvocation';

// Consultation-loop workflow event SSE stream
export { useConsultationEvents, type UseConsultationEventsReturn, type ConsultationEventsStreamStatus } from './useConsultationEvents';

// Audio recordings hook (dual-capture X8)
export { useAudioRecordings, type UseAudioRecordingsReturn } from './useAudioRecordings';

// Pipeline management hook (incl. default/toggle/versions)
export { usePipelines, type UsePipelinesReturn } from './usePipelines';
export type { Pipeline, CreatePipelineInput, UpdatePipelineInput, PipelineValidationResult, PipelineVersion } from './usePipelines';

// STT language-mode catalog hook
export { useArcaSttLanguageModes, type UseArcaSttLanguageModesReturn } from './useArcaSttLanguageModes';

// Native 2-way STT provider toggle — pipeline (primary) ↔ default (fallback)
export { useSttProviderToggle, type UseSttProviderToggleReturn, type SttFallbackProvider } from './useSttProviderToggle';
// Batch (pre-recorded file) transcription — up to N recordings, monitored to
// completion.
export {
  useBatchTranscription,
  type UseBatchTranscriptionProps,
  type UseBatchTranscriptionReturn,
  type BatchTranscriptionLimitsResponse,
} from './useBatchTranscription';

// User settings hook (self-only, `/users/me/settings`)
export { useUserSettings, type UseUserSettingsReturn } from './useUserSettings';

// Voice embedding hook
export { useVoiceEmbedding, type UseVoiceEmbeddingReturn } from './useVoiceEmbedding';
export type { VoiceProfile, EnrollFiles, EnrollOptions, VoiceEnrollmentTarget } from './useVoiceEmbedding';

// Voice enrollment status helper + checker interface
export {
  useVoiceEnrollmentStatus,
  createVoiceEnrollmentChecker,
  type UseVoiceEnrollmentStatusOptions,
  type UseVoiceEnrollmentStatusReturn,
  type VoiceEnrollmentChecker,
} from './useVoiceEnrollmentStatus';

// LOCAL in-browser voice-embedding provider — sits alongside the
// backend `useVoiceEmbedding`; extracts a WavLM speaker embedding client-side.
export { useLocalVoiceEmbedding } from './useLocalVoiceEmbedding';
export type {
  UseLocalVoiceEmbeddingReturn,
  UseLocalVoiceEmbeddingOptions,
  LocalVoiceEmbeddingRecord,
  LocalVoiceStatus,
} from './useLocalVoiceEmbedding';

// Policy management hook
export { usePolicies, type UsePoliciesReturn } from './usePolicies';
export type { Policy, CreatePolicyInput, UpdatePolicyInput, BreakGlassCredentials } from './usePolicies';

// Shared connection management (multi-tab)
export {
  useSharedConnection,
  useSharedSSE,
  useSharedWS,
  type UseSharedConnectionReturn,
  type UseSharedSSEOptions,
  type UseSharedSSEReturn,
  type UseSharedWSOptions,
  type UseSharedWSReturn,
} from './useSharedConnection';

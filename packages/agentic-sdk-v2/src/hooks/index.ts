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

// DNA writing-style doctor SELF-service hook — report/redaction-rules/settings/generate
export { useDnaReport, type UseDnaReportReturn, type PollDnaJobOptions } from './useDnaReport';

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

// TASK-1039: one hook for one run, workflow OR agent — start with an Idempotency-Key, stream protocol
// v2 over a run-scoped ticket, resume by seq (also on mount), read the result. Replaces the
// frame-level `useWorkflowRun` for new code. (`useRunAudio` lives in the plugins entry: it needs capture.)
export { useRun, type StartRunOptions, type UseRunOptions, type UseRunReturn } from './useRun';

// TASK-890: release a `core.humanReview` node — the durable wait a run parks on.
export { useWorkflowReview, type UseWorkflowReviewReturn } from './useWorkflowReview';

// TASK-890 (OD-F): invoke a PUBLISHED agent from the browser (blocking JSON or SSE).
// Business plane only — authoring/publishing agents is `@arcaai/vox-node`'s `hope.admin.*`.
export { useAgentInvocation, type UseAgentInvocationReturn } from './useAgentInvocation';

// Consultation-loop workflow event SSE stream
export { useConsultationEvents, type UseConsultationEventsReturn, type ConsultationEventsStreamStatus } from './useConsultationEvents';

// Audio recordings hook (dual-capture X8)
export { useAudioRecordings, type UseAudioRecordingsReturn } from './useAudioRecordings';

// STT language-mode catalog hook
export { useArcaSttLanguageModes, type UseArcaSttLanguageModesReturn } from './useArcaSttLanguageModes';

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

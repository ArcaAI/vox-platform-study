'use client';

/**
 * @arcaai/vox/compat
 *
 * Opt-in v1-compatibility surface (TASK-561). Ships the HOPE-v1
 * (`@arcaai/agentic-sdk`) hook names as thin adapters over the v2
 * (`@arcaai/vox`) public API, so a migrating app changes only its imports and
 * adds ONE `<ArcaCompatProvider>` (or maps its config via
 * {@link mapV1ConfigToAgenticConfig}).
 *
 * These adapters ONLY consume the public v2 API — they never modify v2 core
 * hooks, store, or clients.
 *
 * @example
 * ```tsx
 * // 1. Change imports: '@arcaai/agentic-sdk' → '@arcaai/vox/compat'
 * import {
 *   ArcaCompatProvider,
 *   useArcaSessionManager,
 *   useAudioCapture,
 *   useArcaSpeechToText,
 *   useSMR,
 * } from '@arcaai/vox/compat';
 *
 * // 2. Wrap the tree once.
 * <ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>
 *   <App />
 * </ArcaCompatProvider>
 * ```
 *
 * @packageDocumentation
 */

// Provider + config adapter
export { ArcaCompatProvider, type ArcaCompatProviderProps } from './compat/ArcaCompatProvider';
export { mapV1ConfigToAgenticConfig } from './compat/config-adapter';

// Hooks
export { useArcaSessionManager, mapV2StatusToV1 } from './compat/useArcaSessionManager';
export type { UseArcaSessionManagerProps, UseArcaSessionManagerReturn } from './compat/useArcaSessionManager';

export { useAudioCapture } from './compat/useAudioCapture';
export type { UseAudioCaptureProps, UseAudioCaptureReturn } from './compat/useAudioCapture';

export { useArcaSpeechToText } from './compat/useArcaSpeechToText';
export type { UseArcaSpeechToTextProps, UseArcaSpeechToTextReturn } from './compat/useArcaSpeechToText';

export { useSMR } from './compat/useSMR';
export type { UseSMROptions, UseSMRReturn } from './compat/useSMR';

// v1 type surface (TASK-560 §5)
export type {
  V1SdkConfig,
  V1AudioSettings,
  ErrorInfo,
  SessionStatus,
  MedicalSession,
  SessionMetadata,
  PatientInfo,
  ProviderInfo,
  AudioDeviceStatus,
  SummaryResponse,
  MedicalSummary,
  EnhancedMedicalSummary,
  SimplifiedMedicalSummary,
  SoapMedicalSummary,
  SMRRequest,
  SMRJobStatus,
  ConversationSegmentInput,
  TestResult,
  PreviousVisitRecord,
  PreSummaryRequest,
  PreSummaryResponse,
  StructuredPreSummary,
  PreSummarySection,
  PreSummarySectionItem,
} from './compat/types';

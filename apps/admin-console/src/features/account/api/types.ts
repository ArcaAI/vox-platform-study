/**
 * Self-service surfaces every authenticated console user can reach:
 * tenants/me, tenants/me/entitlements, user/me settings + preferences.
 */

export type WorkflowMode = 'local' | 'remote';

/** GET /users/me/preferences (UserPreferencesResponse). */
export interface UserPreferences {
  workflowMode?: WorkflowMode;
  language?: string;
  dnaStyleId?: string;
  localConfig?: LocalWorkflowConfig;
  /** Read-only: assigned pipeline info. */
  remoteConfig?: {
    pipelineId: string;
    pipelineName?: string;
    assignedBy: 'admin' | 'tenant-default';
    codeSwitchingEnabled?: boolean;
  };
  /** Read-only: the active voice enrollment. */
  activeVoiceProfile?: { id: string; label?: string; modelId?: string; createdAt: string };
  custom?: Record<string, unknown>;
  transcriptionMode: 'LOCAL' | 'BACKEND';
  transcriptionModeLocked: boolean;
  updatedAt: string;
}

export interface LocalWorkflowConfig {
  noiseCancellation?: { modelId?: string; level?: 'low' | 'medium' | 'high' };
  stt?: { modelId?: string };
  vad?: { modelId?: string; sensitivity?: number };
  ner?: { modelId?: string; autoExtract?: boolean };
  diarization?: { enabled?: boolean; autoEnroll?: boolean };
  voiceProfile?: { autoActivateLatest?: boolean; similarityThreshold?: number; useBackendAnchor?: boolean };
}

/** PATCH /users/me/preferences body (remoteConfig is NOT settable). */
export interface UpdateUserPreferencesRequest {
  workflowMode?: WorkflowMode;
  language?: string;
  dnaStyleId?: string;
  localConfig?: LocalWorkflowConfig;
  custom?: Record<string, unknown>;
}

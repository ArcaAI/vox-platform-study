import type { AppConfig } from '@arcaai/vox';
import { create } from 'zustand';

const BROWSER_VIABLE_MODELS = new Set(['whisper-tiny', 'whisper-base', 'whisper-small']);

function normalizeModelId(id: string): string {
  const stripped = id.replace(/^whisper-/, '');
  const SIZES = ['tiny', 'base', 'small', 'medium', 'large'];
  return SIZES.includes(stripped) ? `whisper-${stripped}` : id;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface SpeakerVoiceFeatures {
  source?: string;
  vector?: number[];
  profileSamples?: number;
  similarity?: number;
  sampleRate?: number;
}

export interface TranscriptEntry {
  id: string;
  segment: number;
  text: string;
  timestamp: number;
  isFinal: boolean;
  speaker?: string;
  speakerLabel?: string;
  speakerConfidence?: number;
  speakerFeatures?: SpeakerVoiceFeatures;
  start: number;
  end: number;
  duration: number;
  inference: number;
  wordTimestamps?: WordTimestamp[];
  /**
   * TASK-304 Wave 3 hotfix — per-segment replay audio (Blob URL).
   *
   * When present, the playback panel uses this URL directly via `new Audio(url)`
   * instead of seeking into the parallel `MediaRecorder` (webm) blob. The VAD
   * already hands us the exact Float32Array for each segment in `onSpeechEnd`;
   * encoding it as a stand-alone WAV gives the `<audio>` element accurate
   * duration metadata, avoiding the few-ms playback truncation caused by
   * partial WebM blobs reporting `audio.duration === Infinity`.
   *
   * Owner of the URL is the `useTranscriptSegmentPlayback` hook; it must call
   * `URL.revokeObjectURL` when the entry is cleared or the component unmounts.
   */
  audioUrl?: string;
}

export type AudioSourceType = 'microphone' | 'file';

export interface MicrophoneSource {
  id: string;
  type: 'microphone';
  deviceId: string;
  label: string;
  gain: number;
  muted: boolean;
}

export interface FileSource {
  id: string;
  type: 'file';
  file: File;
  label: string;
}

export type AudioInputSource = MicrophoneSource | FileSource;

export type NoiseCancellationLevel = 'low' | 'medium' | 'high';
export type ProcessingMethod = 'local_ai' | 'backend_socket';

export type WsStatus = 'idle' | 'creating_session' | 'connecting' | 'streaming' | 'reconnecting' | 'stopping' | 'error';

export type SseStatus = 'idle' | 'uploading' | 'streaming' | 'complete' | 'error';

export interface LocalAsrModelOption {
  id: string;
  name: string;
  size?: string;
}

interface AudioState {
  sources: AudioInputSource[];
  sourceType: AudioSourceType | null;

  isMixing: boolean;
  mixedStream: MediaStream | null;

  processingMethod: ProcessingMethod;
  noiseFilterEnabled: boolean;
  noiseFilterLevel: NoiseCancellationLevel;
  vadEnabled: boolean;
  vadThreshold: number;
  diarizationEnabled: boolean;
  codeSwitchingEnabled: boolean;
  whisperModel: string;
  availableAsrModels: LocalAsrModelOption[];
  language: string;
  selectedPipelineId: string | null;
  configReady: boolean;

  isCapturing: boolean;
  audioLevel: number;
  isSpeaking: boolean;
  speechProbability: number;

  transcripts: TranscriptEntry[];

  wsStatus: WsStatus;
  wsSessionId: string | null;
  wsReconnectAttempts: number;
  bytesSent: number;

  sseStatus: SseStatus;
  sseJobId: string | null;
  uploadProgress: number;
}

interface AudioActions {
  addMicrophoneSource: (deviceId: string, label: string) => void;
  removeMicrophoneSource: (id: string) => void;
  updateMicrophoneSource: (id: string, updates: Partial<Pick<MicrophoneSource, 'gain' | 'muted'>>) => void;
  setFileSource: (file: File) => void;
  clearSources: () => void;

  setMixing: (mixing: boolean) => void;
  setMixedStream: (stream: MediaStream | null) => void;

  setProcessingMethod: (method: ProcessingMethod) => void;
  toggleNoiseFilter: () => void;
  setNoiseFilterLevel: (level: NoiseCancellationLevel) => void;
  toggleVAD: () => void;
  setVADThreshold: (threshold: number) => void;
  toggleDiarization: () => void;
  toggleCodeSwitching: () => void;
  setWhisperModel: (model: string) => void;
  setLanguage: (language: string) => void;
  setSelectedPipelineId: (id: string | null) => void;

  applyTenantDefaults: (config: {
    defaultLanguage?: string;
    defaultSttModel?: string;
    vadSensitivity?: number;
    codeSwitching?: boolean;
    localAsrModels?: LocalAsrModelOption[];
  }) => void;
  /** Apply resolved config from SDK ConfigManager (TASK-244) */
  applyResolvedConfig: (config: AppConfig) => void;
  setConfigReady: (ready: boolean) => void;

  setCapturing: (capturing: boolean) => void;
  setAudioLevel: (level: number) => void;
  setSpeaking: (speaking: boolean) => void;
  setSpeechProbability: (probability: number) => void;

  addTranscript: (entry: TranscriptEntry) => void;
  replacePartialTranscript: (entry: TranscriptEntry) => void;
  clearTranscripts: () => void;

  setWsStatus: (status: WsStatus) => void;
  setWsSessionId: (sessionId: string | null) => void;
  setWsReconnectAttempts: (attempts: number) => void;
  addBytesSent: (bytes: number) => void;

  setSseStatus: (status: SseStatus) => void;
  setSseJobId: (jobId: string | null) => void;
  setUploadProgress: (progress: number) => void;

  reset: () => void;
}

const initialState: AudioState = {
  sources: [],
  sourceType: null,

  isMixing: false,
  mixedStream: null,

  processingMethod: 'backend_socket',
  noiseFilterEnabled: false,
  noiseFilterLevel: 'medium',
  vadEnabled: false,
  vadThreshold: 0.5,
  diarizationEnabled: false,
  codeSwitchingEnabled: false,
  whisperModel: 'whisper-tiny',
  availableAsrModels: [
    { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
    { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
    { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
  ],
  language: '',
  selectedPipelineId: null,
  configReady: false,

  isCapturing: false,
  audioLevel: 0,
  isSpeaking: false,
  speechProbability: 0,

  transcripts: [],

  wsStatus: 'idle',
  wsSessionId: null,
  wsReconnectAttempts: 0,
  bytesSent: 0,

  sseStatus: 'idle',
  sseJobId: null,
  uploadProgress: 0,
};

export const useAudioStore = create<AudioState & AudioActions>()((set, get) => ({
  ...initialState,

  addMicrophoneSource: (deviceId, label) =>
    set((s) => {
      if (s.sources.some((src) => src.type === 'microphone' && src.deviceId === deviceId)) return s;
      const source: MicrophoneSource = {
        id: `mic-${Date.now()}-${deviceId.slice(0, 6)}`,
        type: 'microphone',
        deviceId,
        label,
        gain: 1.0,
        muted: false,
      };
      return { sources: [...s.sources, source], sourceType: 'microphone' };
    }),

  removeMicrophoneSource: (id) =>
    set((s) => {
      const next = s.sources.filter((src) => src.id !== id);
      return { sources: next, sourceType: next.length > 0 ? s.sourceType : null };
    }),

  updateMicrophoneSource: (id, updates) =>
    set((s) => ({
      sources: s.sources.map((src) => (src.id === id && src.type === 'microphone' ? { ...src, ...updates } : src)),
    })),

  setFileSource: (file) =>
    set({
      sources: [{ id: `file-${Date.now()}`, type: 'file', file, label: file.name }],
      sourceType: 'file',
    }),

  clearSources: () =>
    set((s) => {
      if (s.mixedStream) {
        s.mixedStream.getTracks().forEach((t) => t.stop());
      }
      return { sources: [], sourceType: null, isMixing: false, mixedStream: null };
    }),

  setMixing: (mixing) => set({ isMixing: mixing }),
  setMixedStream: (stream) =>
    set((s) => {
      if (s.mixedStream && s.mixedStream !== stream) {
        s.mixedStream.getTracks().forEach((t) => t.stop());
      }
      return { mixedStream: stream };
    }),

  setProcessingMethod: (method) => set({ processingMethod: method }),
  toggleNoiseFilter: () => set((s) => ({ noiseFilterEnabled: !s.noiseFilterEnabled })),
  setNoiseFilterLevel: (level) => set({ noiseFilterLevel: level }),
  toggleVAD: () => set((s) => ({ vadEnabled: !s.vadEnabled })),
  setVADThreshold: (threshold) => set({ vadThreshold: threshold }),
  toggleDiarization: () => set((s) => ({ diarizationEnabled: !s.diarizationEnabled })),
  toggleCodeSwitching: () => set((s) => ({ codeSwitchingEnabled: !s.codeSwitchingEnabled })),
  setWhisperModel: (model) => set({ whisperModel: model }),
  setLanguage: (language) => set({ language }),
  setSelectedPipelineId: (id) => set({ selectedPipelineId: id }),

  applyTenantDefaults: (config) => {
    const current = get();
    const updates: Partial<AudioState> = {};

    const rawTenantModels = config.localAsrModels?.length ? config.localAsrModels.map((m) => ({ ...m, id: normalizeModelId(m.id) })) : undefined;

    const tenantAsrModels = rawTenantModels?.filter((m) => BROWSER_VIABLE_MODELS.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));

    if (config.defaultLanguage && config.defaultLanguage !== current.language) {
      updates.language = config.defaultLanguage;
    }

    if (tenantAsrModels && tenantAsrModels.length > 0) {
      const hasSameModelOptions =
        tenantAsrModels.length === current.availableAsrModels.length &&
        tenantAsrModels.every((model, index) => {
          const currentModel = current.availableAsrModels[index];
          return currentModel && currentModel.id === model.id && currentModel.name === model.name && currentModel.size === model.size;
        });

      if (!hasSameModelOptions) {
        updates.availableAsrModels = tenantAsrModels;
      }
    }

    if (config.defaultSttModel) {
      const normalizedDefault = normalizeModelId(config.defaultSttModel);
      const effectiveModels = tenantAsrModels ?? current.availableAsrModels;
      const canUseDefaultModel = effectiveModels.some((model) => model.id === normalizedDefault);
      if (canUseDefaultModel && normalizedDefault !== normalizeModelId(current.whisperModel)) {
        updates.whisperModel = normalizedDefault;
      }
    }

    if (config.vadSensitivity != null) {
      if (config.vadSensitivity !== current.vadThreshold) {
        updates.vadThreshold = config.vadSensitivity;
      }
      const nextVadEnabled = config.vadSensitivity > 0;
      if (nextVadEnabled !== current.vadEnabled) {
        updates.vadEnabled = nextVadEnabled;
      }
    }

    if (config.codeSwitching != null && config.codeSwitching !== current.codeSwitchingEnabled) {
      updates.codeSwitchingEnabled = config.codeSwitching;
    }

    const availableAsrModels = tenantAsrModels && tenantAsrModels.length > 0 ? tenantAsrModels : current.availableAsrModels;
    const nextWhisperModel = normalizeModelId(updates.whisperModel ?? current.whisperModel);
    if (availableAsrModels.length > 0) {
      const hasValidWhisperModel = availableAsrModels.some((model) => model.id === nextWhisperModel);
      if (!hasValidWhisperModel) {
        const firstModel = availableAsrModels[0];
        if (firstModel && firstModel.id !== normalizeModelId(current.whisperModel)) {
          updates.whisperModel = firstModel.id;
        }
      }
    }

    updates.configReady = true;
    set(updates);
  },
  applyResolvedConfig: (config) => {
    const current = get();
    const updates: Partial<AudioState> = {};
    const audio = config.audio;
    const stt = config.stt;

    if (stt?.language != null && stt.language !== current.language) {
      updates.language = stt.language;
    }

    const rawModels = stt?.availableModels?.length ? stt.availableModels.map((m) => ({ ...m, id: normalizeModelId(m.id) })) : undefined;
    const tenantAsrModels = rawModels?.filter((m) => BROWSER_VIABLE_MODELS.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));

    if (tenantAsrModels && tenantAsrModels.length > 0) {
      const hasSameModelOptions =
        tenantAsrModels.length === current.availableAsrModels.length &&
        tenantAsrModels.every((model, index) => {
          const currentModel = current.availableAsrModels[index];
          return currentModel && currentModel.id === model.id && currentModel.name === model.name && currentModel.size === model.size;
        });
      if (!hasSameModelOptions) {
        updates.availableAsrModels = tenantAsrModels;
      }
    }

    if (stt?.defaultModel) {
      const normalizedDefault = normalizeModelId(stt.defaultModel);
      const effectiveModels = tenantAsrModels ?? current.availableAsrModels;
      const canUseDefaultModel = effectiveModels.some((m) => m.id === normalizedDefault);
      if (canUseDefaultModel && normalizedDefault !== normalizeModelId(current.whisperModel)) {
        updates.whisperModel = normalizedDefault;
      }
    }

    if (audio?.noiseSuppression != null && audio.noiseSuppression !== current.noiseFilterEnabled) {
      updates.noiseFilterEnabled = audio.noiseSuppression;
    }
    if (audio?.noiseFilterLevel != null && audio.noiseFilterLevel !== current.noiseFilterLevel) {
      updates.noiseFilterLevel = audio.noiseFilterLevel as NoiseCancellationLevel;
    }
    if (audio?.vadEnabled != null && audio.vadEnabled !== current.vadEnabled) {
      updates.vadEnabled = audio.vadEnabled;
    }
    if (audio?.vadThreshold != null && audio.vadThreshold !== current.vadThreshold) {
      updates.vadThreshold = audio.vadThreshold;
    }
    if (audio?.diarization != null && audio.diarization !== current.diarizationEnabled) {
      updates.diarizationEnabled = audio.diarization;
    }
    if (audio?.codeSwitching != null && audio.codeSwitching !== current.codeSwitchingEnabled) {
      updates.codeSwitchingEnabled = audio.codeSwitching;
    }

    const availableAsrModels = tenantAsrModels && tenantAsrModels.length > 0 ? tenantAsrModels : current.availableAsrModels;
    const nextWhisperModel = normalizeModelId(updates.whisperModel ?? current.whisperModel);
    if (availableAsrModels.length > 0) {
      const hasValidWhisperModel = availableAsrModels.some((m) => m.id === nextWhisperModel);
      if (!hasValidWhisperModel) {
        const firstModel = availableAsrModels[0];
        if (firstModel && firstModel.id !== normalizeModelId(current.whisperModel)) {
          updates.whisperModel = firstModel.id;
        }
      }
    }

    updates.configReady = true;
    set(updates);
  },
  setConfigReady: (ready) => set({ configReady: ready }),

  setCapturing: (capturing) => set({ isCapturing: capturing }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setSpeaking: (speaking) => set({ isSpeaking: speaking }),
  setSpeechProbability: (probability) => set({ speechProbability: probability }),

  addTranscript: (entry) => set((s) => ({ transcripts: [...s.transcripts, entry] })),
  replacePartialTranscript: (entry) =>
    set((s) => {
      const finals = s.transcripts.filter((t) => t.isFinal);
      return { transcripts: [...finals, entry] };
    }),
  clearTranscripts: () => set({ transcripts: [] }),

  setWsStatus: (status) => set({ wsStatus: status }),
  setWsSessionId: (sessionId) => set({ wsSessionId: sessionId }),
  setWsReconnectAttempts: (attempts) => set({ wsReconnectAttempts: attempts }),
  addBytesSent: (bytes) => set((s) => ({ bytesSent: s.bytesSent + bytes })),

  setSseStatus: (status) => set({ sseStatus: status }),
  setSseJobId: (jobId) => set({ sseJobId: jobId }),
  setUploadProgress: (progress) => set({ uploadProgress: progress }),

  reset: () =>
    set((s) => {
      if (s.mixedStream) {
        s.mixedStream.getTracks().forEach((t) => t.stop());
      }
      return initialState;
    }),
}));

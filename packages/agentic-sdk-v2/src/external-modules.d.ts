/**
 * Type declarations for external ARCAAI packages
 * These are placeholder declarations until the packages have proper type exports
 */

declare module '@arcaai/room' {
  export interface ProcessorInitOptions {
    track: MediaStreamTrack;
    audioContext: AudioContext;
  }

  export interface BaseProcessor {
    init(options: ProcessorInitOptions): Promise<void>;
    destroy(): Promise<void>;
    enable(): Promise<void>;
    disable(): Promise<void>;
    isEnabled(): boolean;
    restart(options: ProcessorInitOptions): Promise<void>;
    on(event: string, callback: (payload: unknown) => void): void;
    off(event: string, callback: (payload: unknown) => void): void;
  }

  export interface RoomOptions {
    url?: string;
    token?: string;
  }

  export interface AudioTrack {
    kind: 'audio';
    id: string;
    enabled: boolean;
  }

  export interface Room {
    connect(url: string, token: string): Promise<void>;
    disconnect(): Promise<void>;
    localParticipant: {
      publishTrack(track: MediaStreamTrack): Promise<void>;
    };
  }

  export function createRoom(options?: RoomOptions): Room;
}

declare module '@arcaai/noise-filter' {
  import type { BaseProcessor } from '@arcaai/room';

  export interface NoiseFilterOptions {
    noiseCancellation?: boolean;
    noiseCancellationLevel?: 'low' | 'medium' | 'high';
  }

  export interface NoiseFilterProcessor extends BaseProcessor {
    process(audioData: Float32Array): Float32Array;
  }

  export function createNoiseFilter(options?: NoiseFilterOptions): NoiseFilterProcessor;
}

declare module '@arcaai/vad' {
  import type { BaseProcessor } from '@arcaai/room';

  export interface VADOptions {
    threshold?: number;
    minSpeechDuration?: number;
    minSilenceDuration?: number;
  }

  export interface VADEvent {
    type: 'speech-start' | 'speech-end';
    timestamp: number;
  }

  export interface VADProcessor extends BaseProcessor {
    process(audioData: Float32Array): VADEvent | null;
  }

  export function createVAD(options?: VADOptions): VADProcessor;
}

declare module '@arcaai/stt' {
  import type { BaseProcessor } from '@arcaai/room';

  export interface STTOptions {
    provider?: 'local' | 'backend' | 'auto';
    language?: string;
    model?: string;
  }

  export interface TranscriptionSegment {
    start: number;
    end: number;
    text: string;
    speaker?: string;
  }

  export interface TranscriptionResult {
    text: string;
    isFinal: boolean;
    confidence?: number;
    language?: string;
    segments?: TranscriptionSegment[];
  }

  export interface STTProcessor extends BaseProcessor {
    process(audioData: Float32Array): Promise<TranscriptionResult | null>;
    isProcessing(): boolean;
  }

  export function createSTT(options?: STTOptions): STTProcessor;
}

declare module '@arcaai/med-ner' {
  export interface MedNEROptions {
    model?: 'default' | 'biomedical' | 'clinical' | string;
    threshold?: number;
    entityTypes?: string[];
    dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
    onEntitiesExtracted?: (result: MedNERResult) => void;
    onError?: (error: Error) => void;
    onProgress?: (progress: ModelLoadProgress) => void;
  }

  export interface EntitySpan {
    text: string;
    type: string;
    start: number;
    end: number;
    score: number;
    rawLabel?: string;
  }

  export interface MedNERResult {
    text: string;
    entities: EntitySpan[];
    processingTime: number;
    model?: string;
    timestamp: number;
  }

  export interface ModelLoadProgress {
    status: string;
    progress: number;
    file?: string;
  }

  export interface MedNERProcessor {
    init(): Promise<void>;
    extract(text: string): Promise<MedNERResult>;
    isInitialized(): boolean;
    isSupported(): boolean;
    destroy(): Promise<void>;
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback: (...args: unknown[]) => void): void;
  }

  export function createMedNER(options?: MedNEROptions): MedNERProcessor;

  export interface UseMedNEROptions {
    autoExtract?: boolean;
    model?: string;
    threshold?: number;
    entityTypes?: string[];
  }

  export interface UseMedNERReturn {
    entities: EntitySpan[];
    extract: (text: string) => Promise<MedNERResult>;
    isLoading: boolean;
    isInitialized: boolean;
    error: Error | null;
    stats: { processingTime: number } | null;
  }

  export function useMedNER(options?: UseMedNEROptions): UseMedNERReturn;
}

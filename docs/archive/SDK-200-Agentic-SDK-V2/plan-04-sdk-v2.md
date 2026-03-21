# Plan 04: SDK v2 Implementation

| Field | Value |
|-------|-------|
| **Parent Ticket** | SDK-200 |
| **Phase** | 4 - SDK Package |
| **Created Date** | 2026-01-11 |
| **Last Updated** | 2026-01-11 |
| **Status** | Pending |
| **Dependencies** | Plan 01 (Prisma) ✅, Plan 02 (Domain Layer) ✅, Plan 03 (API Layer) ✅ |

---

## Important Notes from Plan 03 Implementation

Based on the completed API layer implementation, the SDK types must align with these changes:

| Aspect | Original Plan | Updated |
|--------|---------------|---------|
| **sessionId** | In Consultation type | **Removed** - not part of schema |
| **Source values** | Uppercase (`USER`, `AI`) | **Lowercase** (`user`, `ai`, `system`, `transcription`) |
| **contentVersion** | In ContextItem | **Removed** - not in schema |
| **isNewVisit/isRevisit** | Helper functions only | **Also returned as derived fields** from API |
| **department** | Only in CreateConsultation | **Also in StartRevisit** |
| **Additional endpoints** | Limited | Added `transcriptions`, `case-notes` specific endpoints |

---

## Overview

Create the `@arcaai/vox` package providing React hooks for medical consultation workflows. The SDK composes existing plugin packages (`@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`) and provides a simplified, standardized API.

---

## Package Structure

```
packages/agentic-sdk-v2/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── README.md
├── src/
│   ├── index.ts                    # Main entry - exports all public APIs
│   ├── types/
│   │   ├── index.ts                # Re-export all types
│   │   ├── consultation.ts         # Consultation types
│   │   ├── context.ts              # Context types
│   │   ├── audio.ts                # Audio/STT types
│   │   ├── summary.ts              # Summary types
│   │   └── common.ts               # Shared types (status, errors)
│   ├── core/
│   │   ├── index.ts
│   │   ├── ApiClient.ts            # HTTP client for backend
│   │   └── constants.ts            # Default values, endpoints
│   ├── store/
│   │   ├── index.ts
│   │   └── agenticStore.ts         # Zustand store
│   ├── providers/
│   │   ├── index.ts
│   │   └── AgenticProvider.tsx     # Root provider component
│   ├── hooks/
│   │   ├── index.ts
│   │   ├── useArcaSessionManager.ts    # Consultation management
│   │   ├── useArcaAudio.ts             # Audio capture + processing
│   │   ├── useArcaContext.ts           # Context management
│   │   ├── useArcaSummary.ts           # Summary generation
│   │   └── useArcaSettings.ts          # User settings
│   └── utils/
│       ├── index.ts
│       ├── dateUtils.ts            # Date formatting helpers
│       └── errorUtils.ts           # Error handling
└── examples/
    ├── basic-usage.tsx
    ├── consultation-workflow.tsx
    └── audio-transcription.tsx
```

---

## Step 1: Package Configuration

### package.json

**File**: `packages/agentic-sdk-v2/package.json`

```json
{
  "name": "@arcaai/vox",
  "version": "2.0.0",
  "description": "ARCAAI Agentic SDK v2 for medical consultation workflows",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "sideEffects": false,
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts,.tsx",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@arcaai/room": "workspace:*",
    "@arcaai/noise-filter": "workspace:*",
    "@arcaai/stt": "workspace:*",
    "@arcaai/vad": "workspace:*",
    "zustand": "^5.0.0"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  },
  "keywords": [
    "arcaai",
    "medical",
    "consultation",
    "speech-to-text",
    "react",
    "hooks"
  ]
}
```

### tsup.config.ts

**File**: `packages/agentic-sdk-v2/tsup.config.ts`

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['react', 'react-dom'],
  treeshake: true,
});
```

---

## Step 2: Core Types

### Common Types

**File**: `packages/agentic-sdk-v2/src/types/common.ts`

```typescript
/**
 * Standardized hook status
 */
export interface HookStatus {
  isLoading: boolean;
  error: Error | null;
}

/**
 * Extended status for async operations
 */
export interface AsyncStatus extends HookStatus {
  isProcessing?: boolean;
}

/**
 * SDK Configuration
 */
export interface AgenticSDKConfig {
  apiBaseUrl: string;
  apiKey: string;
  tenantId?: string;
  debug?: boolean;
}
```

### Consultation Types

**File**: `packages/agentic-sdk-v2/src/types/consultation.ts`

```typescript
/**
 * Consultation entity from backend
 * Note: isNewVisit and isRevisit are derived fields returned by the API
 */
export interface Consultation {
  id: string;
  patientId: string;
  appointmentDate: string;  // YYYY-MM-DD format
  doctorId: string;
  doctorName?: string;
  parentConsultationId?: string;  // NULL = new-visit
  isNewVisit: boolean;            // Derived: true if parentConsultationId is null
  isRevisit: boolean;             // Derived: true if parentConsultationId is set
  status: string;
  department?: string;
  startedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  contextItems?: ContextItem[];   // Included when fetching with context
  createdAt: string;
  updatedAt: string;
}

/**
 * Derived: Check if consultation is a new-visit
 */
export const isNewVisit = (c: Consultation): boolean => !c.parentConsultationId;

/**
 * Derived: Check if consultation is a re-visit
 */
export const isRevisit = (c: Consultation): boolean => !!c.parentConsultationId;

/**
 * Input for creating a new consultation
 */
export interface CreateConsultationInput {
  patientId: string;
  appointmentDate: string;  // YYYY-MM-DD format
  doctorId: string;
  doctorName?: string;
  department?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for starting a re-visit
 */
export interface StartRevisitInput {
  parentConsultationId: string;
  doctorId: string;
  doctorName?: string;
  department?: string;            // Added: department is available for re-visits
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating consultation
 */
export interface UpdateConsultationInput {
  status?: string;
  department?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Actions available on useArcaSessionManager
 */
export interface SessionManagerActions {
  create: (input: CreateConsultationInput) => Promise<Consultation>;
  startRevisit: (input: StartRevisitInput) => Promise<Consultation>;
  update: (updates: UpdateConsultationInput) => Promise<void>;
  load: (consultationId: string) => Promise<Consultation>;
  findByPatientDate: (patientId: string, date: string) => Promise<Consultation[]>;
  end: () => Promise<void>;
}
```

### Context Types

**File**: `packages/agentic-sdk-v2/src/types/context.ts`

```typescript
/**
 * Context item from backend
 * Note: source uses lowercase values, derived fields are returned by API
 */
export interface ContextItem {
  id: string;
  consultationId: string;
  type: string;                   // transcription, case_note, summary, pre_summary, audio_segment
  content: string;
  structuredData?: Record<string, unknown>;
  source: 'user' | 'system' | 'transcription' | 'ai';  // lowercase values
  isSummary: boolean;             // Derived: true if type is summary or pre_summary
  isTranscription: boolean;       // Derived: true if type is transcription
  isAiGenerated: boolean;         // Derived: true if source is ai
  createdAt: string;
  updatedAt: string;
}

/**
 * Medical entity extracted via NER
 */
export interface MedicalEntity {
  id: string;
  entityType: string;
  text: string;
  normalizedText?: string;
  codes?: {
    icd10?: string[];
    snomed?: string[];
    rxnorm?: string[];
  };
  confidence: number;
  startOffset: number;
  endOffset: number;
}

/**
 * NER data response
 */
export interface NERData {
  entities: MedicalEntity[];
  contextItemId?: string;
}

/**
 * Input for adding context
 */
export interface AddContextInput {
  type: string;                   // transcription, case_note, summary, pre_summary, audio_segment
  content: string;
  structuredData?: Record<string, unknown>;
  source?: 'user' | 'system' | 'transcription' | 'ai';  // lowercase, defaults to 'user'
}

/**
 * Case note input (convenience type)
 */
export interface CaseNoteInput {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Actions available on useArcaContext
 * Note: getTranscriptions and getCaseNotes are new endpoints from Plan 03
 */
export interface ContextActions {
  addCaseNote: (note: CaseNoteInput) => Promise<ContextItem>;
  addTranscription: (text: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  addContext: (input: AddContextInput) => Promise<ContextItem>;
  updateContext: (id: string, content: string) => Promise<void>;
  getContextItems: (filters?: { type?: string; source?: string }) => Promise<ContextItem[]>;
  getSharedContext: () => Promise<ContextItem[]>;
  getTranscriptions: () => Promise<ContextItem[]>;    // Added: dedicated endpoint
  getCaseNotes: () => Promise<ContextItem[]>;         // Added: dedicated endpoint
  getNERData: (contextId?: string) => Promise<NERData>;
  clearContext: () => void;
}
```

### Summary Types

**File**: `packages/agentic-sdk-v2/src/types/summary.ts`

```typescript
/**
 * Pre-summary options
 */
export interface PreSummaryOptions {
  dnaStyleId?: string;
  options?: Record<string, unknown>;
}

/**
 * Summary generation options
 */
export interface SummaryOptions {
  transcription?: string;  // Override auto-collected transcription
  dnaStyleId?: string;
  template?: string;
  includeNER?: boolean;
  options?: Record<string, unknown>;
}

/**
 * Summary response
 */
export interface Summary {
  id: string;
  contextItemId: string;
  content: string;
  llmProvider: string;
  modelName: string;
  processingTimeMs?: number;
  dnaStyleId?: string;
  createdAt: string;
}

/**
 * Pre-summary response
 */
export interface PreSummary extends Summary {
  type: 'pre_summary';
}

/**
 * DNA Writing Style
 */
export interface DNAStyle {
  id: string;
  name: string;
  description?: string;
  styleData: Record<string, unknown>;
}

/**
 * Actions available on useArcaSummary
 */
export interface SummaryActions {
  generatePreSummary: (options?: PreSummaryOptions) => Promise<PreSummary>;
  generateSummary: (options?: SummaryOptions) => Promise<Summary>;
  updateSummary: (summaryId: string, content: string) => Promise<void>;
  analyzeDNA: (texts: string[]) => Promise<DNAStyle>;
  getDNAStyle: (userId: string) => Promise<DNAStyle | null>;
}
```

### Audio Types

**File**: `packages/agentic-sdk-v2/src/types/audio.ts`

```typescript
import type { AudioTrack } from '@arcaai/room';

/**
 * Transcription result from STT
 */
export interface TranscriptionResult {
  text: string;
  segments?: TranscriptionSegment[];
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

/**
 * Transcription segment with timing
 */
export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/**
 * VAD (Voice Activity Detection) event
 */
export interface VADEvent {
  type: 'speech-start' | 'speech-end' | 'misfire';
  timestamp: number;
  audioData?: Float32Array;
}

/**
 * Audio status
 */
export interface AudioStatus {
  isCapturing: boolean;
  isMuted: boolean;
  isProcessing: boolean;
  level: number;
  error: Error | null;
}

/**
 * Audio options
 */
export interface AudioOptions {
  enableNoiseFilter?: boolean;
  enableVAD?: boolean;
  sttProvider?: 'local' | 'backend' | 'auto';
  onTranscription?: (result: TranscriptionResult) => void;
  onVAD?: (event: VADEvent) => void;
}

/**
 * Actions available on useArcaAudio
 */
export interface AudioActions {
  startCapture: () => Promise<void>;
  stopCapture: () => Promise<void>;
  mute: () => void;
  unmute: () => void;
  setNoiseFilter: (enabled: boolean) => void;
}
```

---

## Step 3: Zustand Store

**File**: `packages/agentic-sdk-v2/src/store/agenticStore.ts`

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Consultation, ContextItem } from '../types';

export interface UserSettings {
  preferredLanguage: string;
  sttProvider: 'local' | 'backend' | 'auto';
  enableNoiseFilter: boolean;
  enableVAD: boolean;
  defaultDnaStyleId?: string;
}

interface AgenticState {
  // Initialization
  initialized: boolean;
  apiKey: string | null;
  apiBaseUrl: string | null;

  // Consultation state
  consultation: Consultation | null;
  relatedConsultations: Consultation[];

  // Context state
  context: ContextItem[];
  sharedContext: ContextItem[];

  // Settings
  settings: UserSettings;

  // Error state
  error: Error | null;
}

interface AgenticActions {
  // Initialization
  initialize: (config: { apiKey: string; apiBaseUrl: string }) => void;
  reset: () => void;

  // Consultation
  setConsultation: (consultation: Consultation | null) => void;
  setRelatedConsultations: (consultations: Consultation[]) => void;

  // Context
  setContext: (context: ContextItem[]) => void;
  addContextItem: (item: ContextItem) => void;
  updateContextItem: (id: string, updates: Partial<ContextItem>) => void;
  setSharedContext: (context: ContextItem[]) => void;
  clearContext: () => void;

  // Settings
  updateSettings: (settings: Partial<UserSettings>) => void;

  // Error
  setError: (error: Error | null) => void;
}

const defaultSettings: UserSettings = {
  preferredLanguage: 'en',
  sttProvider: 'auto',
  enableNoiseFilter: true,
  enableVAD: true,
};

export const useAgenticStore = create<AgenticState & AgenticActions>()(
  persist(
    (set, get) => ({
      // Initial state
      initialized: false,
      apiKey: null,
      apiBaseUrl: null,
      consultation: null,
      relatedConsultations: [],
      context: [],
      sharedContext: [],
      settings: defaultSettings,
      error: null,

      // Actions
      initialize: (config) =>
        set({
          initialized: true,
          apiKey: config.apiKey,
          apiBaseUrl: config.apiBaseUrl,
        }),

      reset: () =>
        set({
          consultation: null,
          relatedConsultations: [],
          context: [],
          sharedContext: [],
          error: null,
        }),

      setConsultation: (consultation) => set({ consultation }),

      setRelatedConsultations: (consultations) =>
        set({ relatedConsultations: consultations }),

      setContext: (context) => set({ context }),

      addContextItem: (item) =>
        set((state) => ({ context: [...state.context, item] })),

      updateContextItem: (id, updates) =>
        set((state) => ({
          context: state.context.map((item) =>
            item.id === id ? { ...item, ...updates } : item
          ),
        })),

      setSharedContext: (sharedContext) => set({ sharedContext }),

      clearContext: () => set({ context: [], sharedContext: [] }),

      updateSettings: (settings) =>
        set((state) => ({
          settings: { ...state.settings, ...settings },
        })),

      setError: (error) => set({ error }),
    }),
    {
      name: 'arcaai-agentic-sdk',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        settings: state.settings,
        // Don't persist sensitive data
      }),
    }
  )
);
```

---

## Step 4: API Client

**File**: `packages/agentic-sdk-v2/src/core/ApiClient.ts`

```typescript
import { useAgenticStore } from '../store';

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(baseUrl: string, apiKey: string, timeout = 30000) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeout = timeout;
  }

  static fromStore(): ApiClient {
    const { apiBaseUrl, apiKey } = useAgenticStore.getState();
    if (!apiBaseUrl || !apiKey) {
      throw new Error('SDK not initialized. Wrap your app with <AgenticProvider>');
    }
    return new ApiClient(apiBaseUrl, apiKey);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `HTTP ${response.status}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }

  get<T>(endpoint: string): Promise<T> {
    return this.request('GET', endpoint);
  }

  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request('POST', endpoint, body);
  }

  patch<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request('PATCH', endpoint, body);
  }

  delete<T>(endpoint: string): Promise<T> {
    return this.request('DELETE', endpoint);
  }
}
```

---

## Step 5: Provider Component

**File**: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`

```typescript
import React, { useEffect, createContext, useContext, useMemo } from 'react';
import { RoomProvider } from '@arcaai/room';
import { useAgenticStore } from '../store';
import type { AgenticSDKConfig } from '../types';

interface AgenticContextValue {
  initialized: boolean;
  config: AgenticSDKConfig;
}

const AgenticContext = createContext<AgenticContextValue | null>(null);

export interface AgenticProviderProps {
  config: AgenticSDKConfig;
  children: React.ReactNode;
}

export function AgenticProvider({ config, children }: AgenticProviderProps) {
  const initialize = useAgenticStore((state) => state.initialize);
  const initialized = useAgenticStore((state) => state.initialized);

  useEffect(() => {
    initialize({
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
    });
  }, [config.apiKey, config.apiBaseUrl, initialize]);

  const contextValue = useMemo(
    () => ({ initialized, config }),
    [initialized, config]
  );

  return (
    <AgenticContext.Provider value={contextValue}>
      <RoomProvider>
        {children}
      </RoomProvider>
    </AgenticContext.Provider>
  );
}

export function useAgenticContext(): AgenticContextValue {
  const context = useContext(AgenticContext);
  if (!context) {
    throw new Error('useAgenticContext must be used within <AgenticProvider>');
  }
  return context;
}
```

---

## Step 6: React Hooks

### useArcaSessionManager

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaSessionManager.ts`

```typescript
import { useState, useCallback, useMemo } from 'react';
import { ApiClient } from '../core';
import { useAgenticStore } from '../store';
import type {
  Consultation,
  CreateConsultationInput,
  StartRevisitInput,
  UpdateConsultationInput,
  HookStatus,
  SessionManagerActions,
} from '../types';

interface UseArcaSessionManagerReturn {
  consultation: Consultation | null;
  relatedConsultations: Consultation[];
  status: HookStatus;
  actions: SessionManagerActions;
}

export function useArcaSessionManager(): UseArcaSessionManagerReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const consultation = useAgenticStore((s) => s.consultation);
  const relatedConsultations = useAgenticStore((s) => s.relatedConsultations);
  const setConsultation = useAgenticStore((s) => s.setConsultation);
  const setRelatedConsultations = useAgenticStore((s) => s.setRelatedConsultations);
  const reset = useAgenticStore((s) => s.reset);

  const create = useCallback(async (input: CreateConsultationInput): Promise<Consultation> => {
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<Consultation>('/consultations', input);
      setConsultation(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to create consultation');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [setConsultation]);

  const startRevisit = useCallback(async (input: StartRevisitInput): Promise<Consultation> => {
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<Consultation>(
        `/consultations/${input.parentConsultationId}/revisit`,
        input
      );
      setConsultation(result);
      // Update related consultations
      const chain = await client.get<Consultation[]>(`/consultations/${result.id}/chain`);
      setRelatedConsultations(chain);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to start re-visit');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [setConsultation, setRelatedConsultations]);

  const update = useCallback(async (updates: UpdateConsultationInput): Promise<void> => {
    if (!consultation) throw new Error('No active consultation');
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.patch<Consultation>(`/consultations/${consultation.id}`, updates);
      setConsultation(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to update consultation');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation, setConsultation]);

  const load = useCallback(async (consultationId: string): Promise<Consultation> => {
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.get<Consultation>(`/consultations/${consultationId}`);
      setConsultation(result);
      // Load related consultations for context sharing
      const chain = await client.get<Consultation[]>(`/consultations/${consultationId}/chain`);
      setRelatedConsultations(chain);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load consultation');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [setConsultation, setRelatedConsultations]);

  const findByPatientDate = useCallback(async (
    patientId: string,
    date: string
  ): Promise<Consultation[]> => {
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      return await client.get<Consultation[]>(
        `/consultations?patientId=${patientId}&date=${date}`
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to find consultations');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const end = useCallback(async (): Promise<void> => {
    if (!consultation) throw new Error('No active consultation');
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      await client.post(`/consultations/${consultation.id}/end`);
      reset();
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to end consultation');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation, reset]);

  const actions = useMemo<SessionManagerActions>(() => ({
    create,
    startRevisit,
    update,
    load,
    findByPatientDate,
    end,
  }), [create, startRevisit, update, load, findByPatientDate, end]);

  return {
    consultation,
    relatedConsultations,
    status: { isLoading, error },
    actions,
  };
}
```

### useArcaContext

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts`

```typescript
import { useState, useCallback, useMemo } from 'react';
import { ApiClient } from '../core';
import { useAgenticStore } from '../store';
import type {
  ContextItem,
  CaseNoteInput,
  AddContextInput,
  NERData,
  HookStatus,
  ContextActions,
} from '../types';

interface UseArcaContextReturn {
  context: ContextItem[];
  sharedContext: ContextItem[];
  status: HookStatus;
  actions: ContextActions;
}

export function useArcaContext(): UseArcaContextReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const consultation = useAgenticStore((s) => s.consultation);
  const context = useAgenticStore((s) => s.context);
  const sharedContext = useAgenticStore((s) => s.sharedContext);
  const addContextItem = useAgenticStore((s) => s.addContextItem);
  const setSharedContext = useAgenticStore((s) => s.setSharedContext);
  const clearContextStore = useAgenticStore((s) => s.clearContext);

  const getConsultationId = (): string => {
    if (!consultation) throw new Error('No active consultation');
    return consultation.id;
  };

  const addCaseNote = useCallback(async (note: CaseNoteInput): Promise<ContextItem> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<ContextItem>(
        `/consultations/${consultationId}/context`,
        { type: 'case_note', content: note.content, source: 'USER' }
      );
      addContextItem(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to add case note');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation, addContextItem]);

  const addTranscription = useCallback(async (
    text: string,
    metadata?: Record<string, unknown>
  ): Promise<ContextItem> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<ContextItem>(
        `/consultations/${consultationId}/context`,
        { type: 'transcription', content: text, structuredData: metadata, source: 'TRANSCRIPTION' }
      );
      addContextItem(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to add transcription');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation, addContextItem]);

  const addContext = useCallback(async (input: AddContextInput): Promise<ContextItem> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<ContextItem>(
        `/consultations/${consultationId}/context`,
        input
      );
      addContextItem(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to add context');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation, addContextItem]);

  const updateContext = useCallback(async (id: string, content: string): Promise<void> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      await client.patch(`/consultations/${consultationId}/context/${id}`, { content });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to update context');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation]);

  const getSharedContext = useCallback(async (): Promise<ContextItem[]> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.get<ContextItem[]>(
        `/consultations/${consultationId}/context/shared`
      );
      setSharedContext(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to get shared context');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation, setSharedContext]);

  const getNERData = useCallback(async (contextId?: string): Promise<NERData> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const endpoint = contextId
        ? `/consultations/${consultationId}/context/${contextId}/entities`
        : `/consultations/${consultationId}/entities`;
      return await client.get<NERData>(endpoint);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to get NER data');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation]);

  const clearContext = useCallback((): void => {
    clearContextStore();
  }, [clearContextStore]);

  const actions = useMemo<ContextActions>(() => ({
    addCaseNote,
    addTranscription,
    addContext,
    updateContext,
    getSharedContext,
    getNERData,
    clearContext,
  }), [addCaseNote, addTranscription, addContext, updateContext, getSharedContext, getNERData, clearContext]);

  return {
    context,
    sharedContext,
    status: { isLoading, error },
    actions,
  };
}
```

### useArcaAudio

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`

```typescript
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useRoom, useAudioTrack, useProcessors, useAudioLevel } from '@arcaai/room';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';
import { VADProcessor } from '@arcaai/vad';
import { STTProcessor } from '@arcaai/stt';
import { useAgenticStore } from '../store';
import type {
  AudioStatus,
  AudioOptions,
  AudioActions,
  TranscriptionResult,
} from '../types';

interface UseArcaAudioReturn {
  track: MediaStreamTrack | null;
  status: AudioStatus;
  actions: AudioActions;
}

export function useArcaAudio(options?: AudioOptions): UseArcaAudioReturn {
  const [error, setError] = useState<Error | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const processorsRef = useRef<{
    noiseFilter?: NoiseFilterProcessor;
    vad?: VADProcessor;
    stt?: STTProcessor;
  }>({});

  const settings = useAgenticStore((s) => s.settings);
  const { room } = useRoom();
  const { track, isCapturing, startCapture, stopCapture, mute, unmute, isMuted } = useAudioTrack();
  const { addProcessor, removeProcessor, setProcessorEnabled } = useProcessors({ track });
  const { level } = useAudioLevel(track);

  // Initialize processors
  useEffect(() => {
    if (!track) return;

    const initProcessors = async () => {
      try {
        setIsProcessing(true);

        // Noise filter
        if (options?.enableNoiseFilter ?? settings.enableNoiseFilter) {
          const noiseFilter = new NoiseFilterProcessor();
          await addProcessor(noiseFilter);
          processorsRef.current.noiseFilter = noiseFilter;
        }

        // VAD
        if (options?.enableVAD ?? settings.enableVAD) {
          const vad = new VADProcessor();
          vad.on('speech-start', () => {
            options?.onVAD?.({ type: 'speech-start', timestamp: Date.now() });
          });
          vad.on('speech-end', (data) => {
            options?.onVAD?.({ type: 'speech-end', timestamp: Date.now(), audioData: data });
          });
          await addProcessor(vad);
          processorsRef.current.vad = vad;
        }

        // STT
        const sttProvider = options?.sttProvider ?? settings.sttProvider;
        const stt = new STTProcessor({ provider: sttProvider });
        stt.on('transcription', (result: TranscriptionResult) => {
          options?.onTranscription?.(result);
        });
        await addProcessor(stt);
        processorsRef.current.stt = stt;

      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to initialize processors'));
      } finally {
        setIsProcessing(false);
      }
    };

    initProcessors();

    return () => {
      // Cleanup processors
      Object.values(processorsRef.current).forEach(processor => {
        if (processor) removeProcessor(processor);
      });
      processorsRef.current = {};
    };
  }, [track]);

  const setNoiseFilter = useCallback((enabled: boolean) => {
    if (processorsRef.current.noiseFilter) {
      setProcessorEnabled(processorsRef.current.noiseFilter, enabled);
    }
  }, [setProcessorEnabled]);

  const actions = useMemo<AudioActions>(() => ({
    startCapture: async () => {
      try {
        await startCapture();
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to start capture'));
        throw err;
      }
    },
    stopCapture: async () => {
      try {
        await stopCapture();
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to stop capture'));
        throw err;
      }
    },
    mute,
    unmute,
    setNoiseFilter,
  }), [startCapture, stopCapture, mute, unmute, setNoiseFilter]);

  const status: AudioStatus = {
    isCapturing,
    isMuted,
    isProcessing,
    level,
    error,
  };

  return {
    track: track?.mediaStreamTrack ?? null,
    status,
    actions,
  };
}
```

### useArcaSummary

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts`

```typescript
import { useState, useCallback, useMemo } from 'react';
import { ApiClient } from '../core';
import { useAgenticStore } from '../store';
import type {
  ContextItem,
  PreSummaryOptions,
  SummaryOptions,
  PreSummary,
  Summary,
  DNAStyle,
  SummaryActions,
} from '../types';

interface SummaryStatus {
  isLoading: boolean;
  isGenerating: boolean;
  isAnalyzingDNA: boolean;
  error: Error | null;
}

interface UseArcaSummaryReturn {
  summaries: ContextItem[];
  dnaStyle: DNAStyle | null;
  status: SummaryStatus;
  actions: SummaryActions;
}

export function useArcaSummary(): UseArcaSummaryReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAnalyzingDNA, setIsAnalyzingDNA] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [dnaStyle, setDnaStyle] = useState<DNAStyle | null>(null);

  const consultation = useAgenticStore((s) => s.consultation);
  const context = useAgenticStore((s) => s.context);
  const addContextItem = useAgenticStore((s) => s.addContextItem);

  const summaries = useMemo(() => {
    return context.filter(
      (item) => item.type === 'summary' || item.type === 'pre_summary'
    );
  }, [context]);

  const getConsultationId = (): string => {
    if (!consultation) throw new Error('No active consultation');
    return consultation.id;
  };

  const generatePreSummary = useCallback(async (
    options?: PreSummaryOptions
  ): Promise<PreSummary> => {
    const consultationId = getConsultationId();
    setIsGenerating(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<PreSummary>(
        `/consultations/${consultationId}/summary/pre-summary`,
        options
      );
      addContextItem({
        id: result.contextItemId,
        consultationId,
        type: 'pre_summary',
        content: result.content,
        source: 'AI',
        contentVersion: 1,
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
      });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to generate pre-summary');
      setError(error);
      throw error;
    } finally {
      setIsGenerating(false);
    }
  }, [consultation, addContextItem]);

  const generateSummary = useCallback(async (options?: SummaryOptions): Promise<Summary> => {
    const consultationId = getConsultationId();
    setIsGenerating(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<Summary>(
        `/consultations/${consultationId}/summary`,
        options
      );
      addContextItem({
        id: result.contextItemId,
        consultationId,
        type: 'summary',
        content: result.content,
        source: 'AI',
        contentVersion: 1,
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
      });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to generate summary');
      setError(error);
      throw error;
    } finally {
      setIsGenerating(false);
    }
  }, [consultation, addContextItem]);

  const updateSummary = useCallback(async (summaryId: string, content: string): Promise<void> => {
    const consultationId = getConsultationId();
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      await client.patch(`/consultations/${consultationId}/summary/${summaryId}`, { content });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to update summary');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [consultation]);

  const analyzeDNA = useCallback(async (texts: string[]): Promise<DNAStyle> => {
    setIsAnalyzingDNA(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.post<DNAStyle>('/dna/analyze', { texts });
      setDnaStyle(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to analyze DNA style');
      setError(error);
      throw error;
    } finally {
      setIsAnalyzingDNA(false);
    }
  }, []);

  const getDNAStyle = useCallback(async (userId: string): Promise<DNAStyle | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const client = ApiClient.fromStore();
      const result = await client.get<DNAStyle | null>(`/dna/styles/${userId}`);
      if (result) setDnaStyle(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to get DNA style');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const actions = useMemo<SummaryActions>(() => ({
    generatePreSummary,
    generateSummary,
    updateSummary,
    analyzeDNA,
    getDNAStyle,
  }), [generatePreSummary, generateSummary, updateSummary, analyzeDNA, getDNAStyle]);

  return {
    summaries,
    dnaStyle,
    status: { isLoading, isGenerating, isAnalyzingDNA, error },
    actions,
  };
}
```

### useArcaSettings

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaSettings.ts`

```typescript
import { useCallback, useMemo } from 'react';
import { useAgenticStore, UserSettings } from '../store';

interface UseArcaSettingsReturn {
  settings: UserSettings;
  actions: {
    updateSettings: (updates: Partial<UserSettings>) => void;
    resetSettings: () => void;
  };
}

const defaultSettings: UserSettings = {
  preferredLanguage: 'en',
  sttProvider: 'auto',
  enableNoiseFilter: true,
  enableVAD: true,
};

export function useArcaSettings(): UseArcaSettingsReturn {
  const settings = useAgenticStore((s) => s.settings);
  const updateSettingsStore = useAgenticStore((s) => s.updateSettings);

  const updateSettings = useCallback((updates: Partial<UserSettings>) => {
    updateSettingsStore(updates);
  }, [updateSettingsStore]);

  const resetSettings = useCallback(() => {
    updateSettingsStore(defaultSettings);
  }, [updateSettingsStore]);

  const actions = useMemo(() => ({
    updateSettings,
    resetSettings,
  }), [updateSettings, resetSettings]);

  return { settings, actions };
}
```

---

## Step 7: Main Entry Point

**File**: `packages/agentic-sdk-v2/src/index.ts`

```typescript
// Provider
export { AgenticProvider, useAgenticContext } from './providers';
export type { AgenticProviderProps } from './providers';

// Hooks
export {
  useArcaSessionManager,
  useArcaAudio,
  useArcaContext,
  useArcaSummary,
  useArcaSettings,
} from './hooks';

// Types
export type {
  // Common
  HookStatus,
  AsyncStatus,
  AgenticSDKConfig,
  // Consultation
  Consultation,
  CreateConsultationInput,
  StartRevisitInput,
  UpdateConsultationInput,
  SessionManagerActions,
  // Context
  ContextItem,
  MedicalEntity,
  NERData,
  AddContextInput,
  CaseNoteInput,
  ContextActions,
  // Summary
  PreSummaryOptions,
  SummaryOptions,
  PreSummary,
  Summary,
  DNAStyle,
  SummaryActions,
  // Audio
  TranscriptionResult,
  TranscriptionSegment,
  VADEvent,
  AudioStatus,
  AudioOptions,
  AudioActions,
} from './types';

// Utilities
export { isNewVisit, isRevisit } from './types/consultation';

// Store (advanced usage)
export { useAgenticStore } from './store';
export type { UserSettings } from './store';

// Core (advanced usage)
export { ApiClient } from './core';
```

---

## Validation Checklist

- [ ] Package configuration created
- [ ] Types defined for all domains
- [ ] Zustand store implemented with persistence
- [ ] ApiClient implemented with error handling
- [ ] AgenticProvider wraps RoomProvider
- [ ] All 5 hooks implemented with standardized pattern
- [ ] Main entry exports all public APIs
- [ ] TypeScript compiles without errors
- [ ] Unit tests for hooks
- [ ] Integration tests with mock API

---

## Next Phase

After completing this phase, proceed to **Plan 05: SDK Examples** to create usage examples and documentation.

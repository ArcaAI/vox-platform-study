'use client';

/**
 * @arcaai/vox/compat - useArcaSessionManager
 *
 * v1 session hook reproduced over v2's `useArcaSession`.
 *
 * Mapping:
 * - `createSession(meta)` + `startSession()` both collapse onto a SINGLE
 *   `useArcaSession().open({ patientId, department, metadata })` (idempotent —
 *   calling both does not open twice). `doctorId` is NOT sent as a top-level
 *   field (v2 derives the doctor from auth); it is preserved in
 *   `metadata.legacyDoctorId`.
 * - `pause`/`resume` have no v2 equivalent → local status only.
 * - `endSession()` → `close()`; `loadSession(id)` → `loadConsultation(id)`;
 *   `updateSession(data)` → `update({ metadata: data })`.
 * - The exposed `session` is a synthesized `MedicalSession` view; v2 status maps
 *   to the v1 enum via {@link mapV2StatusToV1}.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useArcaSession } from '../hooks/useArcaSession';
import type { Consultation, ConsultationStatus } from '../types';
import type { ErrorInfo, MedicalSession, SessionMetadata, SessionStatus } from './types';

export interface UseArcaSessionManagerProps {
  sessionId?: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  options?: Record<string, unknown>;
  onError?: (error: ErrorInfo) => void;
}

export interface UseArcaSessionManagerReturn {
  session: MedicalSession | null;
  isLoading: boolean;
  error: ErrorInfo | null;
  createSession: (metadata?: Partial<SessionMetadata>) => Promise<MedicalSession>;
  startSession: () => Promise<void>;
  pauseSession: (reason?: string) => Promise<void>;
  resumeSession: () => Promise<void>;
  endSession: () => Promise<void>;
  loadSession: (id: string) => Promise<MedicalSession>;
  updateSession: (data?: Record<string, unknown>) => Promise<void>;
  clearError: () => void;
}

/**
 * Map a v2 `ConsultationStatus` onto the v1 `SessionStatus` enum
 * (`OPEN`→`IDLE`, `RECORDING`→`ACTIVE`, `CLOSED`→`TERMINATED`).
 */
export function mapV2StatusToV1(status: ConsultationStatus | undefined): SessionStatus {
  switch (status) {
    case 'RECORDING':
    case 'TRANSCRIBING':
    case 'SUMMARIZING':
    case 'REVIEW':
      return 'ACTIVE';
    case 'CLOSED':
    case 'completed':
      return 'TERMINATED';
    case 'CANCELLED':
    case 'cancelled':
      return 'TERMINATED';
    case 'OPEN':
    case 'active':
    default:
      return 'IDLE';
  }
}

function toErrorInfo(err: unknown, code: string): ErrorInfo {
  return {
    code,
    message: err instanceof Error ? err.message : String(err),
    severity: 'medium',
    category: 'processing',
  };
}

export function useArcaSessionManager(props: UseArcaSessionManagerProps): UseArcaSessionManagerReturn {
  const { doctorId, doctorName, patientId, patientName, onError } = props;
  const session = useArcaSession();

  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Local status override for lifecycle transitions v2 has no equivalent for
  // (pause/resume) plus start/end. `null` ⇒ derive from the v2 consultation.
  const [localStatus, setLocalStatus] = useState<SessionStatus | null>(null);
  // Guards the single collapsed `open()` so createSession + startSession do not
  // open twice.
  const openedRef = useRef(false);

  const buildMetadata = useCallback(
    (metadata?: Partial<SessionMetadata>): SessionMetadata => ({
      tags: metadata?.tags ?? ['medical-consultation'],
      priority: metadata?.priority ?? 'medium',
      sessionType: metadata?.sessionType ?? 'consultation',
      customFields: metadata?.customFields ?? {},
      title: metadata?.title,
      description: metadata?.description,
      patientInfo: metadata?.patientInfo ?? { id: patientId, name: patientName },
      providerInfo: metadata?.providerInfo ?? { id: doctorId, name: doctorName },
      // v2 derives the doctor from auth; keep the v1 id here, never top-level.
      legacyDoctorId: doctorId,
    }),
    [doctorId, doctorName, patientId, patientName],
  );

  const ensureOpen = useCallback(
    async (metadata?: Partial<SessionMetadata>): Promise<Consultation> => {
      if (openedRef.current && session.consultation) {
        return session.consultation;
      }
      const meta = buildMetadata(metadata);
      const consultation = await session.open({
        patientId,
        department: metadata?.providerInfo?.department,
        metadata: { ...meta, doctorName, patientName },
      });
      openedRef.current = true;
      return consultation;
    },
    [session, buildMetadata, patientId, doctorName, patientName],
  );

  const toMedicalSession = useCallback(
    (consultation: Consultation | null): MedicalSession | null => {
      if (!consultation) return null;
      const status = localStatus ?? mapV2StatusToV1(consultation.status);
      const rawMeta = (consultation.metadata ?? {}) as Partial<SessionMetadata>;
      return {
        id: consultation.id,
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
        status,
        startTime: consultation.createdAt ? new Date(consultation.createdAt) : new Date(),
        lastActivity: consultation.updatedAt ? new Date(consultation.updatedAt) : new Date(),
        endTime: status === 'TERMINATED' && consultation.updatedAt ? new Date(consultation.updatedAt) : undefined,
        department: consultation.department,
        metadata: {
          tags: rawMeta.tags ?? [],
          priority: rawMeta.priority ?? 'medium',
          sessionType: rawMeta.sessionType ?? 'consultation',
          customFields: rawMeta.customFields ?? {},
          ...rawMeta,
        },
      };
    },
    [localStatus],
  );

  const run = useCallback(
    async <T>(code: string, work: () => Promise<T>): Promise<T> => {
      setBusy(true);
      setError(null);
      try {
        return await work();
      } catch (err) {
        const info = toErrorInfo(err, code);
        setError(info);
        onError?.(info);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [onError],
  );

  const createSession = useCallback(
    (metadata?: Partial<SessionMetadata>): Promise<MedicalSession> =>
      run('SESSION_CREATE_FAILED', async () => {
        const consultation = await ensureOpen(metadata);
        setLocalStatus('IDLE');
        return toMedicalSession(consultation)!;
      }),
    [run, ensureOpen, toMedicalSession],
  );

  const startSession = useCallback(
    (): Promise<void> =>
      run('SESSION_START_FAILED', async () => {
        await ensureOpen();
        setLocalStatus('ACTIVE');
      }),
    [run, ensureOpen],
  );

  // No v2 equivalent — local status only (documented).
  const pauseSession = useCallback(async (): Promise<void> => {
    setLocalStatus('PAUSED');
  }, []);

  const resumeSession = useCallback(async (): Promise<void> => {
    setLocalStatus('ACTIVE');
  }, []);

  const endSession = useCallback(
    (): Promise<void> =>
      run('SESSION_END_FAILED', async () => {
        if (session.consultation) {
          await session.close();
        }
        setLocalStatus('TERMINATED');
        openedRef.current = false;
      }),
    [run, session],
  );

  const loadSession = useCallback(
    (id: string): Promise<MedicalSession> =>
      run('SESSION_LOAD_FAILED', async () => {
        const consultation = await session.loadConsultation(id);
        openedRef.current = true;
        setLocalStatus(null);
        return toMedicalSession(consultation)!;
      }),
    [run, session, toMedicalSession],
  );

  const updateSession = useCallback(
    (data?: Record<string, unknown>): Promise<void> =>
      run('SESSION_UPDATE_FAILED', async () => {
        await session.update({ metadata: data ?? {} });
      }),
    [run, session],
  );

  const clearError = useCallback(() => setError(null), []);

  const medicalSession = useMemo(() => toMedicalSession(session.consultation), [toMedicalSession, session.consultation]);

  return {
    session: medicalSession,
    isLoading: busy || session.isLoading,
    error,
    createSession,
    startSession,
    pauseSession,
    resumeSession,
    endSession,
    loadSession,
    updateSession,
    clearError,
  };
}

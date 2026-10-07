'use client';

/**
 * TASK-1050 W3b — the consultation playground's guardrail state, in one place (README §9.7.3–§9.7.5,
 * §9.8.1, §9.8.3, OD-15). Sources, merged and deduplicated by `noticeId`:
 *
 * - the consultation's stored notices (`GET :id/guardrail-notices`, the source of truth for state);
 * - live `guardrail.notice` frames on the live-summary channel while recording (W2g relay);
 * - the notices a finished note job or a failed command carried.
 *
 * What the clinician sees:
 *
 * | Outcome | Surface |
 * |---|---|
 * | warn on the FINAL note (its item, or the note job's result) | ONE modal (`dialog`) — acknowledge and continue |
 * | warn / unverified on a live or partial summary | a toast once per check per consultation + an inline badge |
 * | block / hold | the block panel in the note column, with ONLY the allowed resumes |
 *
 * Nothing here carries content: notices are PHI-free by contract and rendered by `messageKey`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { GuardrailHoldResolution } from '@arcaai/types';
import { classifyGuardrailError } from '@/shared/guardrail/guardrail-error';
import type { GuardrailNoticeWithState } from '@/shared/guardrail/guardrail-notice-list';
import { guardrailCheckLabel } from '@/shared/guardrail/labels';
import { createNoticeDeduper, guardrailNoticeCopy, isBlockedNotice, isWarningNotice, mergeGuardrailNotices, toGuardrailNotice, toGuardrailNotices } from '@/shared/guardrail/notice';
import {
  useAcknowledgeGuardrailNotices,
  useGuardrailNotices,
  useLiveGuardrailNotices,
  useResumeGuardrailHold,
  type GuardrailHoldResumeResult,
} from '../api/guardrail';
import type { ConsultationJobStatus } from '../api/types';

export interface ConsultationGuardrailOptions {
  consultationId: string | null;
  /** The persisted final note's item id — a warning on it is a final-note warning (the modal). */
  draftId: string | null;
  /** The live-summary relay is read only while recording. */
  isRecording: boolean;
  /** Called with the consultation state the resume answered (status / processing). */
  onResumed?: (result: GuardrailHoldResumeResult) => void;
}

const EMPTY: GuardrailNoticeWithState[] = [];

function isOpen(notice: GuardrailNoticeWithState): boolean {
  return (notice.status ?? 'open') === 'open';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function useConsultationGuardrail({ consultationId, draftId, isRecording, onResumed }: ConsultationGuardrailOptions) {
  const query = useGuardrailNotices(consultationId, !!consultationId);
  const acknowledge = useAcknowledgeGuardrailNotices(consultationId);
  const resumeMutation = useResumeGuardrailHold(consultationId);

  // Notices learned outside the stored list (live frames, job results, error bodies), per consultation.
  const [local, setLocal] = useState<{ consultationId: string | null; notices: readonly GuardrailNoticeWithState[] }>({ consultationId, notices: EMPTY });
  const [jobFinalIds, setJobFinalIds] = useState<{ consultationId: string | null; ids: ReadonlySet<string> }>({ consultationId, ids: new Set() });
  const [dismissed, setDismissed] = useState<{ consultationId: string | null; ids: ReadonlySet<string> }>({ consultationId, ids: new Set() });
  const [errorBlock, setErrorBlock] = useState<{ consultationId: string | null; code: string | null; redaction: boolean } | null>(null);
  const [pendingResolution, setPendingResolution] = useState<GuardrailHoldResolution['resolution'] | null>(null);

  const addLocal = useCallback(
    (incoming: readonly GuardrailNoticeWithState[]) => {
      if (!consultationId || incoming.length === 0) return;
      setLocal((current) => {
        const base = current.consultationId === consultationId ? current.notices : EMPTY;
        const merged = mergeGuardrailNotices(base, incoming);
        return merged === base && current.consultationId === consultationId ? current : { consultationId, notices: merged };
      });
    },
    [consultationId],
  );

  const refetch = query.refetch;
  useLiveGuardrailNotices(consultationId, isRecording, (notice) => {
    addLocal([notice]);
    void refetch();
  });

  const notices = useMemo(() => {
    const localNotices = local.consultationId === consultationId ? local.notices : EMPTY;
    // The stored list wins: it carries the state (acknowledged / resolved) a frame does not.
    return [...mergeGuardrailNotices(localNotices, query.data?.notices ?? EMPTY)];
  }, [local, consultationId, query.data]);

  const finalIds = jobFinalIds.consultationId === consultationId ? jobFinalIds.ids : null;
  const isFinalNote = useCallback(
    (notice: GuardrailNoticeWithState) => (draftId !== null && notice.itemIds.includes(draftId)) || (finalIds?.has(notice.noticeId) ?? false),
    [draftId, finalIds],
  );

  const openWarnings = useMemo(() => notices.filter((notice) => isOpen(notice) && isWarningNotice(notice)), [notices]);
  const finalNoteWarnings = useMemo(() => openWarnings.filter(isFinalNote), [openWarnings, isFinalNote]);
  const liveWarnings = useMemo(() => openWarnings.filter((notice) => !isFinalNote(notice)), [openWarnings, isFinalNote]);
  const blocking = useMemo(() => notices.find((notice) => isOpen(notice) && isBlockedNotice(notice)) ?? null, [notices]);
  /** Every open warning that still wants an acknowledgement — what the approve confirm step lists. */
  const outstandingWarnings = useMemo(() => openWarnings.filter((notice) => notice.requiresAcknowledgement), [openWarnings]);

  // OD-15: one toast per check per consultation for live / partial warnings. A side effect only.
  const deduper = useRef(createNoticeDeduper());
  useEffect(() => {
    if (!consultationId) return;
    for (const notice of liveWarnings) {
      if (!deduper.current.firstSeen(consultationId, notice)) continue;
      toast.warning(guardrailNoticeCopy(notice), {
        description: notice.checks.map((check) => guardrailCheckLabel(check.checkId)).join(', ') || undefined,
      });
    }
  }, [consultationId, liveWarnings]);

  const dismissedIds = dismissed.consultationId === consultationId ? dismissed.ids : null;
  const dialogNotices = finalNoteWarnings;
  const dialogOpen = dialogNotices.some((notice) => !(dismissedIds?.has(notice.noticeId) ?? false));

  const dismiss = useCallback(
    (ids: readonly string[]) => {
      setDismissed((current) => {
        const base = current.consultationId === consultationId ? current.ids : new Set<string>();
        return { consultationId, ids: new Set([...base, ...ids]) };
      });
    },
    [consultationId],
  );

  const onAcknowledge = useCallback(
    (noticeIds: string[]) => {
      acknowledge.mutate(noticeIds, {
        onSuccess: () => {
          dismiss(noticeIds);
          toast.success(noticeIds.length === 1 ? 'Warning acknowledged' : 'Warnings acknowledged');
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not acknowledge the warning'),
      });
    },
    [acknowledge, dismiss],
  );

  const resume = useCallback(
    (resolution: GuardrailHoldResolution) => {
      setPendingResolution(resolution.resolution);
      resumeMutation.mutate(resolution, {
        onSuccess: (result) => {
          setErrorBlock(null);
          toast.success('Hold resolved. Processing continues; press Record to resume capture.');
          onResumed?.(result);
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not resume the hold'),
        onSettled: () => setPendingResolution(null),
      });
    },
    [resumeMutation, onResumed],
  );

  /** A failed command / generation. True when it was a guardrail outcome (and is now shown). */
  const handleError = useCallback(
    (error: unknown): boolean => {
      const outcome = classifyGuardrailError(error);
      if (!outcome) return false;
      if (outcome.notice) addLocal([outcome.notice]);
      else setErrorBlock({ consultationId, code: outcome.code, redaction: outcome.kind === 'redaction_unavailable' });
      void refetch();
      return true;
    },
    [addLocal, consultationId, refetch],
  );

  /** A note job ended. True when a FAILED job was a guardrail outcome (no generic toast then). */
  const handleJobTerminal = useCallback(
    (job: ConsultationJobStatus): boolean => {
      const result = isRecord(job.result) ? job.result : {};
      const carried = [
        ...toGuardrailNotices<GuardrailNoticeWithState>(result),
        ...[toGuardrailNotice<GuardrailNoticeWithState>((job as unknown as Record<string, unknown>).guardrailNotice ?? result.guardrailNotice)].filter(
          (notice): notice is GuardrailNoticeWithState => notice !== null,
        ),
      ];
      addLocal(carried);
      void refetch();
      const status = job.status.toUpperCase();
      if (status === 'COMPLETED') {
        const warningIds = carried.filter(isWarningNotice).map((notice) => notice.noticeId);
        if (warningIds.length > 0 && consultationId) {
          setJobFinalIds((current) => ({
            consultationId,
            ids: new Set([...(current.consultationId === consultationId ? current.ids : []), ...warningIds]),
          }));
        }
        return false;
      }
      if (status !== 'FAILED') return false;
      if (carried.some(isBlockedNotice)) return true;
      const code = job.error ?? '';
      if (/^(CONTENT_BLOCKED|EGRESS_REDACTION_UNAVAILABLE|GUARDRAIL_)/.test(code)) {
        setErrorBlock({ consultationId, code, redaction: code === 'EGRESS_REDACTION_UNAVAILABLE' });
        return true;
      }
      return false;
    },
    [addLocal, consultationId, refetch],
  );

  return {
    notices,
    blocking,
    liveWarnings,
    finalNoteWarnings,
    outstandingWarnings,
    /** A block that arrived without a notice (an older gateway relays only the legacy code). */
    errorBlock: errorBlock && errorBlock.consultationId === consultationId && !blocking ? errorBlock : null,
    dialog: {
      open: dialogOpen,
      notices: dialogNotices,
      onOpenChange: (open: boolean) => {
        if (!open) dismiss(dialogNotices.map((notice) => notice.noticeId));
      },
      onAcknowledge,
      pending: acknowledge.isPending,
    },
    acknowledge: onAcknowledge,
    acknowledgePending: acknowledge.isPending,
    resume,
    resumePending: resumeMutation.isPending,
    pendingResolution,
    handleError,
    handleJobTerminal,
    refetch,
  };
}

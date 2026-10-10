'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { isGuardrailHoldReason, type GuardrailHoldResolution } from '@arcaai/types';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GuardrailBlockPanel } from '@/shared/guardrail/guardrail-block-panel';
import { isBlockedNotice } from '@/shared/guardrail/notice';
import { useConsultationGuardrailNotices, useResumeConsultationHold } from '../../api/guardrail';

/**
 * TASK-1050 W3b — the consultation is in a guardrail HOLD (`processingReason` `GUARDRAIL_HOLD` or
 * `EGRESS_REDACTION_UNAVAILABLE`, README §9.7.5, §9.8.1): the blocking notice with ONLY the allowed
 * resumes, so a hold is never a dead end. The lifecycle carries state only; the notice is read by id
 * from the notices route.
 */
export function ConsultationHoldBanner({
  consultationId,
  processingReason,
}: {
  consultationId: string;
  processingReason: string | null | undefined;
}) {
  const held = isGuardrailHoldReason(processingReason ?? null);
  // The notices are read always: an OPEN blocking notice is a hold the admin must see even when the
  // lifecycle marker has moved on (TASK-1059 C-03).
  const notices = useConsultationGuardrailNotices(consultationId);
  const resume = useResumeConsultationHold(consultationId);
  const [pending, setPending] = useState<GuardrailHoldResolution['resolution'] | null>(null);
  const blocking = (notices.data ?? []).find((notice) => (notice.status ?? 'open') === 'open' && isBlockedNotice(notice)) ?? null;
  if (!held && !blocking) return null;
  if (held && notices.isPending) return <Skeleton className="h-24 w-full" />;
  return (
    <GuardrailBlockPanel
      notice={blocking}
      code={processingReason === 'EGRESS_REDACTION_UNAVAILABLE' ? 'EGRESS_REDACTION_UNAVAILABLE' : null}
      title={
        processingReason === 'EGRESS_REDACTION_UNAVAILABLE'
          ? 'On hold: patient details could not be protected'
          : 'On hold: a safety check stopped this consultation'
      }
      resumePending={resume.isPending}
      pendingResolution={pending}
      onResume={(resolution) => {
        setPending(resolution.resolution);
        resume.mutate(resolution, {
          onSuccess: () => toast.success('Hold resolved. Processing continues.'),
          onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not resume the hold'),
          onSettled: () => setPending(null),
        });
      }}
    />
  );
}

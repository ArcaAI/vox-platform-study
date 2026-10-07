'use client';

import { IconShieldExclamation } from '@tabler/icons-react';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import type { GuardrailHoldResolution } from '@arcaai/types';
import { GuardrailBlockPanel } from '@/shared/guardrail/guardrail-block-panel';
import { GuardrailNoticeBanner } from '@/shared/guardrail/guardrail-notice-banner';
import type { GuardrailNotice } from '@/shared/guardrail/notice';

/**
 * TASK-1050 W3b — what the note column shows for the consultation's guardrail state:
 *   - a HOLD (an open `guardrail.blocked`, or a block an older gateway relayed without a notice):
 *     the block panel with ONLY the allowed resumes — never a dead end (README §9.8.1);
 *   - live / partial WARNINGS: an inline, non-modal banner (the toast fired once already, OD-15).
 * A final-note warning is the modal's (the screen mounts it); it is not repeated here.
 */
export function ConsultationGuardrailSlot({
  blocking,
  errorBlock,
  liveWarnings,
  onResume,
  resumePending,
  pendingResolution,
}: {
  blocking: GuardrailNotice | null;
  errorBlock: { code: string | null; redaction: boolean } | null;
  liveWarnings: readonly GuardrailNotice[];
  onResume: (resolution: GuardrailHoldResolution) => void;
  resumePending: boolean;
  pendingResolution: GuardrailHoldResolution['resolution'] | null;
}) {
  if (!blocking && !errorBlock && liveWarnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {blocking ? (
        <GuardrailBlockPanel notice={blocking} onResume={onResume} resumePending={resumePending} pendingResolution={pendingResolution} />
      ) : errorBlock ? (
        <GuardrailBlockPanel
          notice={null}
          code={errorBlock.code}
          {...(errorBlock.redaction ? { title: 'Paused: patient details could not be protected' } : {})}
        />
      ) : null}
      {liveWarnings.length > 0 ? <GuardrailNoticeBanner notices={liveWarnings} title="Safety check warning on the live summary" /> : null}
    </div>
  );
}

/** The note header's inline badge: a hold outranks warnings. Text always rides with the colour. */
export function ConsultationGuardrailBadge({ held, warnings }: { held: boolean; warnings: number }) {
  if (held) return <StatusBadge label="Guardrail hold" colorRole="destructive" icon={<IconShieldExclamation aria-hidden />} />;
  if (warnings > 0)
    return (
      <StatusBadge
        label={warnings === 1 ? '1 safety warning' : `${warnings} safety warnings`}
        colorRole="warning"
        icon={<IconShieldExclamation aria-hidden />}
      />
    );
  return null;
}

'use client';

import type { ReactNode } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useConsultation, visitTypeOf } from '../api';
import type { Consultation } from '../api';
import { ConsultationStatusBadge } from './consultation-status-badge';
import { ConsultationWorkflowMeta } from './consultation-workflow-meta';

const EM_DASH = '\u2014';

/**
 * Frame 40 masks the patient identifier ("pt_44s1 (masked)"): show a short
 * prefix, never the full id — this admin surface has no clinical need for it.
 */
function maskPatientId(patientId: string): string {
  return patientId.length <= 7 ? patientId : `${patientId.slice(0, 7)}\u2026`;
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

/** ContextItemType groups the relations summary rolls the detail's items into. */
const RELATION_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Transcript', types: ['TRANSCRIPT'] },
  { label: 'Summary', types: ['RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY'] },
  { label: 'Audio recordings', types: ['AUDIO_RECORDING'] },
  { label: 'Attachments', types: ['ATTACHMENT'] },
  { label: 'Case notes', types: ['CASE_NOTE'] },
  { label: 'Worknotes', types: ['WORKNOTE'] },
  { label: 'Named entities', types: ['NAMED_ENTITY'] },
  { label: 'Signed note', types: ['SIGNED_NOTE'] },
];

function RelationsSummary({ consultation }: { consultation: Consultation }) {
  const items = consultation.contextItems ?? [];
  const groups = RELATION_GROUPS.map((group) => ({
    label: group.label,
    count: items.filter((item) => group.types.includes(item.type)).length,
  })).filter((group) => group.count > 0);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">Relations</h3>
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">No related context items.</p>
      ) : (
        <ul className="flex flex-col">
          {groups.map((group) => (
            <li key={group.label} className="flex items-baseline justify-between gap-3 border-b py-1.5 text-sm last:border-0">
              <span>{group.label}</span>
              <span className="text-muted-foreground tabular-nums">{group.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function doctorName(consultation: Consultation): string {
  const { doctor } = consultation;
  if (!doctor) return consultation.doctorId;
  const fullName = [doctor.firstName, doctor.lastName].filter(Boolean).join(' ');
  return fullName ? `${doctor.username} (${fullName})` : doctor.username;
}

function departmentLabel(consultation: Consultation): string | null {
  const { department } = consultation;
  if (department) return [department.name, department.code].filter(Boolean).join(' \u00b7 ') || department.id;
  return consultation.departmentId ?? null;
}

function DetailBody({ id }: { id: string }) {
  const detail = useConsultation(id);

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  if (detail.isError) {
    return <ErrorState title={'Couldn\u2019t load this consultation'} error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  const consultation = detail.data;
  const visitType = visitTypeOf(consultation);
  const department = departmentLabel(consultation);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <MetaItem label="Patient">
          <span className="font-mono text-xs">{maskPatientId(consultation.patientId)}</span>{' '}
          <span className="text-muted-foreground text-xs">(masked)</span>
        </MetaItem>
        <MetaItem label="Doctor">{doctorName(consultation)}</MetaItem>
        <MetaItem label="Department">{department ?? EM_DASH}</MetaItem>
        <MetaItem label="Status">
          <ConsultationStatusBadge status={consultation.status} />
        </MetaItem>
        {/* Directly after Status, full width: which workflow governed this, and whether it worked. */}
        <ConsultationWorkflowMeta run={consultation.governingRun} />
        <MetaItem label="Type">
          <Badge variant="outline">{visitType === 'new' ? 'New' : 'Revisit'}</Badge>
        </MetaItem>
        <MetaItem label="Appointment date">
          <span className="tabular-nums">{formatDateTime(consultation.appointmentDate, 'date')}</span>
        </MetaItem>
        <MetaItem label="Created">
          <span title={consultation.createdAt} className="tabular-nums">
            {formatDateTime(consultation.createdAt)}
          </span>
        </MetaItem>
        <MetaItem label="Updated">
          <span title={consultation.updatedAt} className="tabular-nums">
            {formatDateTime(consultation.updatedAt)}
          </span>
        </MetaItem>
        {consultation.parentConsultationId ? (
          <MetaItem label="Parent consultation">
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              {consultation.parentConsultationId}
              <CopyButton value={consultation.parentConsultationId} label="Copy parent consultation id" />
            </span>
          </MetaItem>
        ) : null}
      </dl>
      <RelationsSummary consultation={consultation} />
      <p className="text-muted-foreground border-t pt-3 text-xs">Read-only {'\u2014'} no mutations; a plain DOCTOR never passes this guard.</p>
    </div>
  );
}

/**
 * Frame 40 (c) — row-click read-only detail (GET /admin/consultations/:id):
 * masked patient, doctor, department, status, type, timestamps and a compact
 * relations summary of the consultation's context items. No mutations exist
 * on this surface.
 */
export function ConsultationDetailPanel({ consultationId, onOpenChange }: { consultationId: string | null; onOpenChange: (open: boolean) => void }) {
  return (
    <DetailDrawer
      open={consultationId !== null}
      onOpenChange={onOpenChange}
      title={<span className="font-mono text-sm break-all">{consultationId}</span>}
      badges={consultationId ? <CopyButton value={consultationId} label="Copy consultation id" /> : null}
      meta={
        <span>
          Read-only detail {'\u00b7'} <span className="font-mono">GET /admin/consultations/:id</span>
        </span>
      }
    >
      {consultationId ? <DetailBody id={consultationId} /> : null}
    </DetailDrawer>
  );
}

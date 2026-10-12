'use client';

import type { ReactNode } from 'react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime } from '@/shared/format';
import { useConsultation, visitTypeOf } from '../../api';
import { doctorDisplayName } from '../../lib/doctor-name';

const EM_DASH = '—';

function Field({ label, loading, children }: { label: string; loading: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{loading ? <Skeleton className="h-4 w-20" /> : (children ?? EM_DASH)}</dd>
    </div>
  );
}

/** Identity line of the activity header: patient, doctor, department, visit and approval facts. */
export function ConsultationHeaderMeta({ consultationId }: { consultationId: string }) {
  const detail = useConsultation(consultationId);
  const loading = detail.isPending;
  const c = detail.data;
  const doctor = doctorDisplayName(c?.doctor);
  const department = c?.department ? ([c.department.name, c.department.code].filter(Boolean).join(' · ') || c.department.id) : null;
  const itemCount = c?.approval?.itemCount;

  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1" aria-label="Consultation details">
      <Field label="Patient" loading={loading}>
        {c?.patientId ? <span className="font-mono text-xs break-all">{c.patientId}</span> : null}
      </Field>
      <Field label="Doctor" loading={loading}>
        {doctor ? (
          <>
            {doctor.label}
            {doctor.secondary ? <span className="text-muted-foreground ml-1 text-xs">({doctor.secondary})</span> : null}
          </>
        ) : null}
      </Field>
      <Field label="Department" loading={loading}>
        {department}
      </Field>
      <Field label="Visit" loading={loading}>
        {c ? (visitTypeOf(c) === 'new' ? 'New' : 'Revisit') : null}
      </Field>
      <Field label="Appointment" loading={loading}>
        {c?.appointmentDate ? formatDateTime(c.appointmentDate, 'date') : null}
      </Field>
      <Field label="Approved" loading={loading}>
        {c?.approval ? `${formatDateTime(c.approval.approvedAt)} · ${itemCount ?? 0} items` : null}
      </Field>
      <Field label="Closed" loading={loading}>
        {c?.closedReason ?? null}
      </Field>
      <Field label="Auto-close" loading={loading}>
        {c?.autoCloseAt ? formatDateTime(c.autoCloseAt) : null}
      </Field>
      <Field label="Encounters" loading={loading}>
        {c?.encounters ? String(c.encounters.length) : null}
      </Field>
    </dl>
  );
}

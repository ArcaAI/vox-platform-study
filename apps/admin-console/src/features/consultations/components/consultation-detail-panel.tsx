'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useConsultation, visitTypeOf } from '../api';
import type { Consultation } from '../api';
import { doctorDisplayName } from '../lib/doctor-name';
import { ConsultationEncountersSection, ConsultationLifecycleMeta } from './consultation-lifecycle-section';
import { ConsultationStatusBadge } from './consultation-status-badge';
import { ConsultationWorkflowMeta } from './consultation-workflow-meta';
import { PromptInspector } from './prompt-inspector';
import { ConsultationTelemetrySection } from './telemetry/consultation-telemetry-section';

const EM_DASH = '\u2014';

/**
 * Frame 40 masks the patient identifier ("pt_44s1 (masked)"): show a short
 * prefix, never the full id — this admin surface has no clinical need for it.
 */
function maskPatientId(patientId: string): string {
  if (patientId.length <= 7) return patientId;
  // Namespace prefix plus the last four characters (`alaas:E…P01`); an id too short to hide
  // anything between the two keeps the prefix only.
  return patientId.length <= 11 ? `${patientId.slice(0, 7)}\u2026` : `${patientId.slice(0, 7)}\u2026${patientId.slice(-4)}`;
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
  { label: 'Full transcript', types: ['FULL_TRANSCRIPT'] },
  { label: 'Transcript segments', types: ['TRANSCRIPT_SEGMENT'] },
  { label: 'Summary', types: ['RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY'] },
  { label: 'Audio recordings', types: ['AUDIO_RECORDING'] },
  { label: 'Attachments', types: ['ATTACHMENT'] },
  { label: 'Case notes', types: ['CASE_NOTE'] },
  { label: 'Worknotes', types: ['WORKNOTE'] },
  { label: 'Named entities', types: ['NAMED_ENTITY'] },
  { label: 'Signed note', types: ['SIGNED_NOTE'] },
  { label: 'Structured data', types: ['STRUCTURED'] },
  { label: 'Fact ledger', types: ['FACT_LEDGER'] },
  { label: 'Encounter recaps', types: ['ENCOUNTER_RECAP'] },
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

function DoctorName({ consultation }: { consultation: Consultation }) {
  const doctor = doctorDisplayName(consultation.doctor);
  if (!doctor) return <>{consultation.doctorId}</>;
  return (
    <>
      {doctor.label}
      {doctor.secondary ? <span className="text-muted-foreground ml-1 text-xs">({doctor.secondary})</span> : null}
    </>
  );
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
        <MetaItem label="Doctor"><DoctorName consultation={consultation} /></MetaItem>
        <MetaItem label="Department">{department ?? EM_DASH}</MetaItem>
        <MetaItem label="Status">
          <ConsultationStatusBadge
            status={consultation.status}
            processing={consultation.processing}
            processingReason={consultation.processingReason}
            governingRun={consultation.governingRun}
          />
        </MetaItem>
        {/* Directly after Status, full width: which workflow governed this, and whether it worked. */}
        <ConsultationWorkflowMeta run={consultation.governingRun} awaitingReview={consultation.processing === 'AWAITING_REVIEW'} />
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
        <ConsultationLifecycleMeta consultation={consultation} />
        {consultation.parentConsultationId ? (
          <MetaItem label="Parent consultation">
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              {consultation.parentConsultationId}
              <CopyButton value={consultation.parentConsultationId} label="Copy parent consultation id" />
            </span>
          </MetaItem>
        ) : null}
      </dl>
      <ConsultationEncountersSection consultation={consultation} />
      <RelationsSummary consultation={consultation} />
      <ConsultationTelemetrySection consultationId={id} />
      <p className="text-muted-foreground border-t pt-3 text-xs">Read-only {'\u2014'} no mutations; a plain DOCTOR never passes this guard.</p>
    </div>
  );
}

/**
 * Frame 40 (c) — row-click read-only detail (GET /admin/consultations/:id):
 * masked patient, doctor, department, status, type, timestamps and a compact
 * relations summary of the consultation's context items; plus the Prompt
 * Inspector tab (a dry run of a phase's composed LLM request, and the stored
 * records of what was sent). No mutations exist on this surface.
 */
export function ConsultationDetailPanel({ consultationId, onOpenChange }: { consultationId: string | null; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState('overview');
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <DetailDrawer
        open={consultationId !== null}
        onOpenChange={(open) => {
          if (!open) setTab('overview');
          onOpenChange(open);
        }}
        size="xl"
        title={<span className="font-mono text-sm break-all">{consultationId}</span>}
        badges={
          consultationId ? (
            <>
              <CopyButton value={consultationId} label="Copy consultation id" />
              <Button asChild variant="outline" size="xs">
                <Link href={`/consultations/${encodeURIComponent(consultationId)}`}>
                  <IconExternalLink aria-hidden />
                  Open activity
                </Link>
              </Button>
            </>
          ) : null
        }
        meta={
          <span>
            Read-only detail {'\u00b7'} <span className="font-mono">GET /admin/consultations/:id</span>
          </span>
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="prompt-inspector">Prompt inspector</TabsTrigger>
          </TabsList>
        }
      >
        {consultationId ? (
          <>
            <TabsContent value="overview">
              <DetailBody id={consultationId} />
            </TabsContent>
            <TabsContent value="prompt-inspector">
              <PromptInspector consultationId={consultationId} />
            </TabsContent>
          </>
        ) : null}
      </DetailDrawer>
    </Tabs>
  );
}

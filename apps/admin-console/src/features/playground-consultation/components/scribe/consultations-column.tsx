'use client';

/**
 * Column 1 of the Consultation Scribe workspace: the
 * clinician's consultation list. Real rows from the SDK's `listConsultations`
 * (working tenant), client-side search, status badges, a New form (patient ID →
 * `session.open`, the SDK's get-or-create), and selection → `session.load`.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { IconInbox, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { cn } from '@arcaai/ui';
import { EmptyState } from '@/shared/state/empty-state';
import { formatDateTime } from '@/shared/format';

export interface ConsultationListRow {
  id: string;
  patientId: string;
  status: string;
  createdAt?: string;
}

const STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
  OPEN: { label: 'Open', role: 'success' },
  RECORDING: { label: 'Recording', role: 'destructive' },
  PENDING_REVIEW: { label: 'Pending review', role: 'warning' },
  COMPLETED: { label: 'Completed', role: 'success' },
  CLOSED: { label: 'Closed', role: 'neutral' },
};

function statusMeta(status: string): { label: string; role: StatusColorRole } {
  return STATUS_META[status.toUpperCase()] ?? { label: status, role: 'neutral' };
}

/** Initials chip for a patient id (best-effort — ids are opaque). */
function initials(patientId: string): string {
  return (
    patientId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase() || '–'
  );
}

export interface ConsultationsColumnProps {
  rows: ConsultationListRow[];
  isLoading: boolean;
  error: string | null;
  selectedId: string | null;
  /** Select an existing consultation (loads it into the SDK session). */
  onSelect: (row: ConsultationListRow) => void;
  /** Open (get-or-create) a consultation for a patient id. */
  onOpenPatient: (patientId: string) => Promise<void>;
  activeIsRecording: boolean;
}

export function ConsultationsColumn({ rows, isLoading, error, selectedId, onSelect, onOpenPatient, activeIsRecording }: ConsultationsColumnProps) {
  const [query, setQuery] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [patientId, setPatientId] = useState('');
  const [patientIdError, setPatientIdError] = useState<string | null>(null);
  const [openPending, setOpenPending] = useState(false);

  // Toggle the New form; closing it discards any half-typed input.
  function toggleNewForm() {
    if (showNewForm) {
      setPatientId('');
      setPatientIdError(null);
    }
    setShowNewForm((previous) => !previous);
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) => row.patientId.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle) || row.status.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  async function handleOpenSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = patientId.trim();
    if (!trimmed) {
      setPatientIdError('Patient ID is required.');
      return;
    }
    setPatientIdError(null);
    setOpenPending(true);
    try {
      await onOpenPatient(trimmed);
      setShowNewForm(false);
    } finally {
      setOpenPending(false);
    }
  }

  return (
    <section aria-label="Consultations" className="bg-card flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Consultations ({rows.length})</h2>
          <Button size="sm" onClick={toggleNewForm} aria-expanded={showNewForm}>
            {showNewForm ? <IconX aria-hidden /> : <IconPlus aria-hidden />}
            {showNewForm ? 'Cancel' : 'New'}
          </Button>
        </div>
        {showNewForm ? (
          <form noValidate onSubmit={handleOpenSubmit} className="flex flex-col gap-2">
            <Label htmlFor="scribe-patient-id">
              Patient ID{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="scribe-patient-id"
                value={patientId}
                onChange={(event) => setPatientId(event.target.value)}
                aria-invalid={!!patientIdError}
                aria-describedby={patientIdError ? 'scribe-patient-id-error' : undefined}
                placeholder="e.g. patient-0001"
                autoFocus
              />
              <Button type="submit" disabled={openPending}>
                Open
              </Button>
            </div>
            {patientIdError ? (
              <p id="scribe-patient-id-error" className="text-destructive text-sm">
                {patientIdError}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="relative flex items-center">
            <IconSearch aria-hidden className="text-muted-foreground absolute left-2.5 size-4" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search consultations"
              aria-label="Search consultations"
              className="pl-8"
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-1" aria-hidden>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex items-center gap-2.5 rounded-lg p-2.5">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <p role="alert" className="text-destructive px-2 py-3 text-sm">
            {error}
          </p>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={IconInbox}
            title={query ? 'No matches' : 'No consultations yet'}
            description={query ? 'Try a different search.' : 'Open one with New to start a session.'}
          />
        ) : (
          <ul className="flex list-none flex-col gap-0.5">
            {filtered.map((row) => {
              const meta = statusMeta(row.status);
              const selected = row.id === selectedId;
              const recording = selected && activeIsRecording;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(row)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'hover:bg-muted focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left focus-visible:ring-2 focus-visible:outline-none',
                      selected && 'bg-accent shadow-[inset_2px_0_0_var(--primary)]',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                        selected ? 'bg-ai text-ai-foreground' : 'bg-secondary text-secondary-foreground',
                      )}
                    >
                      {initials(row.patientId)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{row.patientId}</span>
                        {row.createdAt ? (
                          <span className="text-muted-foreground shrink-0 font-mono text-2xs">{formatDateTime(row.createdAt)}</span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {recording ? (
                          <Badge variant="destructive" className="gap-1.5">
                            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
                            REC
                          </Badge>
                        ) : (
                          <StatusBadge label={meta.label} colorRole={meta.role} />
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

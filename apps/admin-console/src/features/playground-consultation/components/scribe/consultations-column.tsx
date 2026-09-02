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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
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
  /**
   * Open (get-or-create) a consultation for a patient id, optionally scoped to
   * a department. `departmentId` is what makes the department prompt tier and
   * the workflow-assignment department tier reachable at all (TASK-789 H-4).
   */
  onOpenPatient: (patientId: string, departmentId?: string, workflowDefinitionSlug?: string) => Promise<void>;
  activeIsRecording: boolean;
  /**
   * TASK-858 Lane D — the published consultation workflows this caller may pass as
   * `session.open({ workflowDefinitionSlug })` (SDK `useSelectableConsultationWorkflows`).
   *
   * THREE source states, never collapsed — the SDK keeps them apart for the same reason:
   * `undefined` = the caller did not wire the picker (render nothing), `null` = we could not
   * ask (offline/503/unauthorized), `[]` = the tenant has published none. Telling a clinician
   * their tenant has no workflows because a request blipped is the failure this prevents.
   */
  workflows?: WorkflowSelectionOption[] | null;
  /** Read in flight ⇒ skeleton, never a premature "none". */
  workflowsLoading?: boolean;
  /** Empty ⇒ "use the assigned workflow", i.e. send no slug and let the cascade decide. */
  selectedWorkflowSlug?: string;
  onWorkflowChange?: (slug: string) => void;
  /**
   * Departments the CALLER may scope to — `users/me/departments`, the
   * clinician plane (TASK-815 §12 / P-4). Empty is a real, explainable state,
   * not a reason to hide the control: see `departmentsLoading` /
   * `departmentsError` below.
   */
  departments?: DepartmentOption[];
  /** Catalog read in flight ⇒ skeleton, never a blank or a premature "none". */
  departmentsLoading?: boolean;
  /** Catalog read failed ⇒ say so; the note still drafts at the tenant tier. */
  departmentsError?: boolean;
  selectedDepartmentId?: string;
  onDepartmentChange?: (id: string) => void;
}

/** Minimal department shape the picker needs. */
export interface DepartmentOption {
  id: string;
  name: string;
}

/**
 * One selectable consultation workflow — the console-side shape of the SDK's
 * `SelectableConsultationWorkflow`. Deliberately structural: the screen passes the SDK objects
 * straight through, and this column stays testable without the SDK.
 */
export interface WorkflowSelectionOption {
  /** The value sent as `workflowDefinitionSlug`. */
  slug: string;
  name: string;
  description?: string | null;
  /** `true` for the slug the TENANT-level assignment names — the sensible preselection. */
  isTenantDefault: boolean;
}

/** Sentinel for "no department" — Radix Select forbids an empty-string value. */
const NO_DEPARTMENT = '__none__';

/**
 * Sentinel for "send no slug at all" — the DEFAULT, and the only value that leaves the
 * WorkflowAssignment cascade intact. Sending the tenant default explicitly would silently
 * override a DEPARTMENT assignment, which is a different consultation from the one the tenant
 * configured; `isTenantDefault` is a hint about the tenant tier, never a promise about this
 * consultation.
 */
const ASSIGNED_WORKFLOW = '__assigned__';

/**
 * The department picker's DEGRADED state — a designed state, not a failure.
 *
 * Follows the same idiom as `/playground/dna-writing-style`'s
 * `ImpersonationGatePanel`: name the state, badge it, say plainly what happens
 * instead. `role="status"` because the notice resolves asynchronously — a
 * clinician who never sees the control appear must still be TOLD why.
 */
function DepartmentScopingNotice({ unavailable }: { unavailable: boolean }) {
  return (
    <div role="status" className="border-border bg-muted/40 flex flex-col gap-1.5 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{unavailable ? 'Department scoping unavailable' : 'No department assignments'}</span>
        <StatusBadge label={unavailable ? 'UNAVAILABLE' : 'NONE'} colorRole={unavailable ? 'warning' : 'neutral'} />
      </div>
      <p className="text-muted-foreground text-xs">
        {unavailable
          ? 'Your department list could not be read. The note still drafts \u2014 it is scoped to the tenant tier instead of a department.'
          : 'You are not assigned to a department. The note still drafts \u2014 it is scoped to the tenant tier. A tenant admin assigns departments.'}
      </p>
    </div>
  );
}

/**
 * The workflow picker's DEGRADED states — designed states, not failures, and the two are NOT
 * the same fact: `unavailable` means the read failed, `none` means the tenant has published no
 * consultation workflow. Both are non-blocking; the consultation still opens and the assignment
 * cascade (department → tenant → platform default) decides which engine governs.
 */
function WorkflowSelectionNotice({ unavailable }: { unavailable: boolean }) {
  return (
    <div role="status" className="border-border bg-muted/40 flex flex-col gap-1.5 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{unavailable ? 'Workflow selection unavailable' : 'No published workflows'}</span>
        <StatusBadge label={unavailable ? 'UNAVAILABLE' : 'NONE'} colorRole={unavailable ? 'warning' : 'neutral'} />
      </div>
      <p className="text-muted-foreground text-xs">
        {unavailable
          ? 'The workflow list could not be read, so there is nothing to pick. The consultation still opens \u2014 the assigned workflow governs it.'
          : 'This tenant has published no consultation workflow, so there is nothing to pick. The consultation still opens \u2014 the platform default engine governs it.'}
      </p>
    </div>
  );
}

export function ConsultationsColumn({
  rows,
  isLoading,
  error,
  selectedId,
  onSelect,
  onOpenPatient,
  activeIsRecording,
  departments = [],
  departmentsLoading = false,
  departmentsError = false,
  selectedDepartmentId = '',
  onDepartmentChange,
  workflows,
  workflowsLoading = false,
  selectedWorkflowSlug = '',
  onWorkflowChange,
}: ConsultationsColumnProps) {
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

  /**
   * Patient lookup for the "New" form — there is no dedicated Patient registry in this
   * platform (`patientId` is an opaque string on Consultation), but a doctor's OWN
   * consultation history IS a real, per-clinician patient list. Suggests those ids
   * (deduped, sorted) via a native <datalist> so opening a RETURNING patient no longer
   * depends on retyping their id correctly — while a genuinely new patient can still be
   * typed freehand, since nothing here constrains the field to the suggestion set.
   */
  const patientSuggestions = useMemo(() => Array.from(new Set(rows.map((row) => row.patientId))).sort(), [rows]);

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
      await onOpenPatient(trimmed, selectedDepartmentId || undefined, selectedWorkflowSlug || undefined);
      setShowNewForm(false);
    } finally {
      setOpenPending(false);
    }
  }

  return (
    <section aria-label="Consultations" className="bg-card flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Consultations ({rows.length})</h2>
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
                list="scribe-patient-id-suggestions"
                autoComplete="off"
              />
              <Button type="submit" disabled={openPending}>
                Open
              </Button>
            </div>
            {/* Patient lookup: ids from this clinician's own consultation history. Native
                <datalist> — no registry to query, no custom popover to build; the browser's
                own combobox affordance covers "pick a returning patient" while the input
                stays a real free-text field for a first-time one. */}
            <datalist id="scribe-patient-id-suggestions">
              {patientSuggestions.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {patientIdError ? (
              <p id="scribe-patient-id-error" className="text-destructive text-sm">
                {patientIdError}
              </p>
            ) : null}
            {/* Department scoping — all four states are explained (P-4).
                The catalog used to be an ADMIN read that 403'd under
                impersonation, and every failure collapsed to the same silent
                blank. It is now the clinician-plane `users/me/departments`,
                and when it is genuinely empty or unreadable the clinician is
                TOLD, with the consequence spelled out. */}
            {departmentsLoading ? (
              <>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-full" />
              </>
            ) : departments.length > 0 ? (
              <>
                <Label htmlFor="scribe-department">Department</Label>
                <Select
                  value={selectedDepartmentId || NO_DEPARTMENT}
                  onValueChange={(next) => onDepartmentChange?.(next === NO_DEPARTMENT ? '' : next)}
                >
                  <SelectTrigger id="scribe-department" className="w-full">
                    <SelectValue placeholder="No department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                    {departments.map((department) => (
                      <SelectItem key={department.id} value={department.id}>
                        {department.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Scopes the drafted note to the department&apos;s prompt and agent configuration.
                </p>
              </>
            ) : (
              <DepartmentScopingNotice unavailable={departmentsError} />
            )}
            {/* Workflow selection (TASK-858 Lane D). TASK-813 shipped
                `session.open({ workflowDefinitionSlug })` and the discovery route that says
                which slugs are accepted; nothing in the console offered the choice, so a
                clinician always got whatever the assignment cascade picked. `undefined` keeps
                the control off entirely for callers that do not wire it. */}
            {workflows === undefined ? null : workflowsLoading ? (
              <>
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-9 w-full" />
              </>
            ) : workflows === null ? (
              <WorkflowSelectionNotice unavailable />
            ) : workflows.length === 0 ? (
              <WorkflowSelectionNotice unavailable={false} />
            ) : (
              <>
                <Label htmlFor="scribe-workflow">Workflow</Label>
                <Select
                  value={selectedWorkflowSlug || ASSIGNED_WORKFLOW}
                  onValueChange={(next) => onWorkflowChange?.(next === ASSIGNED_WORKFLOW ? '' : next)}
                >
                  <SelectTrigger id="scribe-workflow" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* The default: no slug leaves the department → tenant assignment in
                        charge, which is what the tenant actually configured. */}
                    <SelectItem value={ASSIGNED_WORKFLOW}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">Use assigned workflow</span>
                        <span className="text-muted-foreground truncate text-xs">the department or tenant assignment decides</span>
                      </span>
                    </SelectItem>
                    {workflows.map((workflow) => (
                      <SelectItem key={workflow.slug} value={workflow.slug}>
                        {/* One ROW, not a stack: `SelectValue` mirrors this content into the
                            trigger, which is a fixed-height `line-clamp-1` flex row — a
                            two-line item would be clipped there. */}
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{workflow.name}</span>
                          {/* A hint about the TENANT tier, not the preselection — a department
                              override can still win when nothing is picked. */}
                          {workflow.isTenantDefault ? <Badge variant="secondary">Default</Badge> : null}
                          <span className="text-muted-foreground truncate font-mono text-xs">{workflow.slug}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Governs this consultation&apos;s realtime and drafting agents. An explicit pick overrides the department and tenant assignment.
                </p>
              </>
            )}
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

      {/* tabIndex 0 — WCAG 2.1.1/2.1.3: while loading or empty this pane
          scrolls with no focusable child, so a keyboard user cannot reach
          its content. axe `scrollable-region-focusable`, impact serious. */}
      <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-2">
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
                        'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                        selected ? 'bg-ai text-ai-foreground' : 'bg-secondary text-secondary-foreground',
                      )}
                    >
                      {initials(row.patientId)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{row.patientId}</span>
                        {row.createdAt ? (
                          <span className="text-muted-foreground shrink-0 font-mono text-xs">{formatDateTime(row.createdAt)}</span>
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

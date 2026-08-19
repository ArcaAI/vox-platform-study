'use client';

/**
 * Fallbacks tab — the conceptual map of HOW a prompt instruction template is
 * chosen.
 *
 * The bug this screen exists to prevent was invisible in the console: the
 * pre-summary and summary capabilities have DIFFERENT SHAPES, and every admin
 * surface rendered them as one undifferentiated list of "prompt templates".
 *
 *   Pre-summary — exactly ONE per tenant. No department axis, no visit-type
 *                  axis. Department and visit type are VARIABLES INSIDE the
 *                  single prompt, never selectors for a different prompt.
 *   Summary — a (department x visit type) matrix, plus one
 *                  department-agnostic SYSTEM fallback.
 *
 * The resolution chains are mirrored from `PromptResolutionService`
 * (`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts`):
 *
 *   pre-summary: tenant TENANT_DEFAULT row (departmentId null, APPROVED,
 *                tagged `pre-summary`, NOT tagged `dept-free`; oldest wins)
 *                -> SYSTEM pre-summary default -> 503 FAIL CLOSED.
 *                It consults NEITHER the doctor-preferred tier, NOR the
 *                department default agent, NOR the department visit-type
 *                columns.
 *   summary: doctor-preferred -> department default Agent (visit-type
 *                aware) -> department column (newPatient / revisit, APPROVED
 *                only) -> SYSTEM default (CATCHALL_SOAP).
 *
 * This tab is READ + the department slot assignment write
 * (`POST assign-department`, which carries the DEPARTMENT row's
 * expectedVersion). Template content/versions/approval stay on the sibling
 * Templates and Governance tabs of this same screen — one authoritative
 * editor per resource (rule 13).
 */

import { useMemo, useState, type FormEvent } from 'react';
import { IconAlertTriangle, IconBuildingHospital, IconFileText, IconInfoCircle } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useAssignDepartment, useDepartments, useTemplates } from '../api/hooks';
import type { AssignDepartmentRequest, Department, PromptTemplate } from '../api/types';
import { ApprovalPin, TemplateStatusBadge } from './approval-pin';

/** The three writable department prompt slots, in resolution-relevant order. */
type SlotField = 'newPatientPromptId' | 'revisitPromptId' | 'preSummaryPromptId';

const PRE_SUMMARY_TAG = 'pre-summary';
const DEPT_FREE_TAG = 'dept-free';

function departmentLabel(row: Department): string {
  return row.code ?? row.name ?? row.id;
}

/**
 * The tenant pre-summary candidates, mirroring `findTenantPreSummaryTemplateId`
 * for the `v1` surface: scope TENANT_DEFAULT, no department, APPROVED, tagged
 * `pre-summary` and NOT tagged `dept-free`. Ordered oldest-first because the
 * server resolves `createdAt asc, id asc` and takes the FIRST row — so more
 * than one candidate is an ambiguity the admin needs to see, not a detail.
 */
function preSummaryCandidates(templates: PromptTemplate[]): PromptTemplate[] {
  return templates
    .filter(
      (template) =>
        template.scope === 'TENANT_DEFAULT' &&
        !template.departmentId &&
        template.status === 'APPROVED' &&
        (template.tags ?? []).includes(PRE_SUMMARY_TAG) &&
        !(template.tags ?? []).includes(DEPT_FREE_TAG),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

/** One template reference cell: name + status + the pinned approval version. */
function TemplateRef({ template }: { template: PromptTemplate }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">{template.name}</span>
      <TemplateStatusBadge status={template.status} />
      <ApprovalPin template={template} />
    </span>
  );
}

/** A slot with nothing assigned — says what actually happens instead. */
function FallsThrough({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground text-xs italic">{children}</span>;
}

/**
 * Pre-summary card — the tenant-wide instruction, deliberately rendered as a
 * SINGLE row with no department/visit-type columns so the shape difference is
 * legible at a glance.
 */
function PreSummaryCard({
  templates,
  departments,
  isPending,
}: {
  templates: PromptTemplate[];
  departments: Department[];
  isPending: boolean;
}) {
  const candidates = useMemo(() => preSummaryCandidates(templates), [templates]);
  const resolved = candidates[0] ?? null;
  // Legacy per-department pre-summary overrides. removed the column
  // from the ArcaAI seed because pre-summary has no department axis; any row
  // still carrying one is stale config and worth surfacing.
  const legacyOverrides = departments.filter((row) => !!row.preSummaryPromptId);

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm leading-none font-semibold">
          Pre-summary
          <Badge variant="secondary" className="text-2xs">
            tenant-wide
          </Badge>
        </h2>
        <p className="text-muted-foreground text-sm">
          Exactly one pre-summary instruction per tenant. It has <strong className="text-foreground">no department axis</strong> and{' '}
          <strong className="text-foreground">no visit-type axis</strong> &mdash; department and visit type are variables inside this one prompt, never
          selectors for a different one.
        </p>
        <p className="text-muted-foreground font-mono text-xs">
          tenant TENANT_DEFAULT (tag {PRE_SUMMARY_TAG}) &rarr; SYSTEM pre-summary default &rarr; 503 fail-closed
        </p>
      </div>

      {isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : resolved ? (
        <div className="rounded-md border p-3">
          <TemplateRef template={resolved} />
        </div>
      ) : (
        // Severity is carried by the icon and the wording as well as the colour —
        // never by colour alone (rule 11 §10).
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>No tenant pre-summary template</AlertTitle>
          <AlertDescription>
            {/* AlertDescription is a grid, so inline spans become their own
                row unless the prose is wrapped in a single block child. */}
            <p>
              No APPROVED tenant-default template is tagged <span className="font-mono">{PRE_SUMMARY_TAG}</span>, so every pre-summary request falls
              through to the SYSTEM default (and fails closed with 503 if that is missing too).
            </p>
          </AlertDescription>
        </Alert>
      )}

      {candidates.length > 1 ? (
        <Alert>
          <IconInfoCircle aria-hidden />
          <AlertTitle>{candidates.length} candidate pre-summary templates</AlertTitle>
          <AlertDescription>
            <p>
              Resolution takes the oldest deterministically &mdash; currently <span className="font-medium">{resolved?.name}</span>. The others never
              serve. Retire or re-tag them to remove the ambiguity.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {legacyOverrides.length > 0 ? (
        <Alert>
          <IconAlertTriangle aria-hidden />
          <AlertTitle>
            {legacyOverrides.length} department{legacyOverrides.length === 1 ? '' : 's'} still carry a per-department pre-summary
          </AlertTitle>
          <AlertDescription>
            <p>
              Pre-summary resolution does not read the department columns, so these are inert leftovers:{' '}
              <span className="font-mono text-xs">{legacyOverrides.map(departmentLabel).join(', ')}</span>. Clear them from the summary matrix below.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </Card>
  );
}

/** Assign / clear one department prompt slot. */
function AssignSlotDialog({
  department,
  slot,
  templates,
  open,
  onOpenChange,
}: {
  department: Department | null;
  slot: SlotField;
  templates: PromptTemplate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const assign = useAssignDepartment();
  const [templateId, setTemplateId] = useState('');

  const SLOT_LABEL: Record<SlotField, string> = {
    newPatientPromptId: 'Summary — New referral',
    revisitPromptId: 'Summary — Re-visit',
    preSummaryPromptId: 'Legacy per-department pre-summary',
  };

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTemplateId('');
      assign.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!department) return;
    const body: AssignDepartmentRequest = {
      departmentId: department.id,
      expectedVersion: department.version,
      [slot]: templateId || null,
    };
    assign.mutate(body, {
      onSuccess: () => {
        toast.success(templateId ? `${SLOT_LABEL[slot]} assigned for ${departmentLabel(department)}` : `${SLOT_LABEL[slot]} cleared`);
        handleOpenChange(false);
      },
      onError: (error) => {
        // OCC conflicts render the inline reload alert instead of a toast.
        if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
        toast.error(error instanceof GatewayError ? error.message : 'Could not update the department slot.');
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{department ? `${SLOT_LABEL[slot]} — ${departmentLabel(department)}` : SLOT_LABEL[slot]}</DialogTitle>
          <DialogDescription>
            Writes the department&apos;s prompt slot. <span className="font-mono text-xs">POST assign-department</span> carries the department row&apos;s
            version, so a concurrent edit is rejected rather than silently overwritten.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="assign-slot-template">Template</Label>
            <NativeSelect id="assign-slot-template" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <NativeSelectOption value="">{'— none (fall through) —'}</NativeSelectOption>
              {templates.map((template) => (
                <NativeSelectOption key={template.id} value={template.id}>
                  {template.name}
                  {template.status === 'APPROVED' ? '' : ` (${template.status.toLowerCase()} — will not resolve)`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-muted-foreground text-xs">Only APPROVED templates resolve for clinical flows; anything else is skipped at runtime.</p>
          </div>
          <OccConflictAlert error={assign.error} onReload={() => assign.reset()} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!department || assign.isPending}>
              {assign.isPending ? <Spinner /> : null}
              Save slot
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Summary card — the two-axis matrix. The pre-summary column deliberately
 * shows "n/a — tenant-wide" rather than being omitted, so the difference from
 * the card above reads as a designed distinction and not an oversight.
 */
function SummaryMatrixCard({
  templates,
  departments,
  isPending,
  onAssign,
}: {
  templates: PromptTemplate[];
  departments: Department[];
  isPending: boolean;
  onAssign: (department: Department, slot: SlotField) => void;
}) {
  const byId = useMemo(() => new Map(templates.map((template) => [template.id, template])), [templates]);

  /** Department-agnostic summary fallback: tenant-default, no department, category SUMMARY. */
  const agnostic = useMemo(
    () => templates.find((template) => template.scope === 'TENANT_DEFAULT' && !template.departmentId && template.category === 'SUMMARY') ?? null,
    [templates],
  );

  function slotCell(department: Department, slot: SlotField) {
    const id = department[slot];
    const template = id ? byId.get(id) : undefined;
    return (
      <TableCell>
        <span className="flex flex-wrap items-center gap-2">
          {template ? (
            <TemplateRef template={template} />
          ) : id ? (
            <span className="text-muted-foreground font-mono text-xs">{id}</span>
          ) : (
            <FallsThrough>{'— falls through to the department-agnostic fallback —'}</FallsThrough>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onAssign(department, slot)}
            aria-label={`Change ${slot === 'newPatientPromptId' ? 'New referral' : 'Re-visit'} template for ${departmentLabel(department)}`}
          >
            Change
          </Button>
        </span>
      </TableCell>
    );
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm leading-none font-semibold">
          Summary
          <Badge variant="outline" className="text-2xs">
            department &times; visit type
          </Badge>
        </h2>
        <p className="text-muted-foreground text-sm">
          Summary instructions are chosen on <strong className="text-foreground">two axes</strong>: the department, and the visit type (New referral
          or Re-visit). Every department gets its own pair; anything unmatched falls back to the department-agnostic template.
        </p>
        <p className="text-muted-foreground font-mono text-xs">
          doctor-preferred &rarr; department default Agent &rarr; department column (APPROVED only) &rarr; SYSTEM default
        </p>
      </div>

      <div className="rounded-md border p-3">
        <span className="text-muted-foreground text-xs">Department-agnostic fallback</span>
        <div className="mt-1">
          {isPending ? (
            <Skeleton className="h-5 w-64" />
          ) : agnostic ? (
            <TemplateRef template={agnostic} />
          ) : (
            <FallsThrough>{'— none in this tenant; the SYSTEM default (CATCHALL_SOAP) serves —'}</FallsThrough>
          )}
        </div>
      </div>

      {isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : departments.length === 0 ? (
        <EmptyState icon={IconBuildingHospital} title="No departments" description="This tenant has no departments, so there is no summary matrix." />
      ) : (
        // The shadcn `Table` already renders its own focusable `overflow-x-auto`
        // container — a second wrapper would nest scroll areas (rule 11 §1).
        <Table aria-label="Summary instructions by department and visit type">
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="min-w-32">
                Department
              </TableHead>
              <TableHead scope="col" className="min-w-64">
                Summary &mdash; New referral
              </TableHead>
              <TableHead scope="col" className="min-w-64">
                Summary &mdash; Re-visit
              </TableHead>
              <TableHead scope="col" className="min-w-40">
                Pre-summary
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((department) => (
              <TableRow key={department.id}>
                <TableCell className="font-mono text-xs">{departmentLabel(department)}</TableCell>
                {slotCell(department, 'newPatientPromptId')}
                {slotCell(department, 'revisitPromptId')}
                <TableCell>
                  {department.preSummaryPromptId ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant="destructive" className="text-2xs">
                        legacy override
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => onAssign(department, 'preSummaryPromptId')}
                        aria-label={`Clear legacy pre-summary override for ${departmentLabel(department)}`}
                      >
                        Clear
                      </Button>
                    </span>
                  ) : (
                    <FallsThrough>{'n/a — tenant-wide'}</FallsThrough>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function PromptFallbacksTab() {
  // A tenant's template set is small (tens), so one wide read feeds both cards
  // and the assign picker rather than three narrower ones.
  const templatesQuery = useTemplates({ limit: 200 });
  const departmentsQuery = useDepartments();
  const [assigning, setAssigning] = useState<{ department: Department; slot: SlotField } | null>(null);

  const templates = templatesQuery.data?.data ?? [];
  const departments = departmentsQuery.data ?? [];
  const isPending = templatesQuery.isPending || departmentsQuery.isPending;

  if (templatesQuery.error) return <ErrorState error={templatesQuery.error} onRetry={() => void templatesQuery.refetch()} />;
  if (departmentsQuery.error) return <ErrorState error={departmentsQuery.error} onRetry={() => void departmentsQuery.refetch()} />;

  if (!isPending && templates.length === 0) {
    return (
      <EmptyState
        icon={IconFileText}
        title="No prompt templates yet"
        description="Create a template on the Templates tab, then come back to see how it resolves."
      />
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Prompt fallbacks">
      <PreSummaryCard templates={templates} departments={departments} isPending={isPending} />
      <SummaryMatrixCard
        templates={templates}
        departments={departments}
        isPending={isPending}
        onAssign={(department, slot) => setAssigning({ department, slot })}
      />
      <AssignSlotDialog
        key={assigning ? `${assigning.department.id}:${assigning.slot}` : 'none'}
        department={assigning?.department ?? null}
        slot={assigning?.slot ?? 'newPatientPromptId'}
        templates={templates}
        open={assigning !== null}
        onOpenChange={(open) => !open && setAssigning(null)}
      />
    </section>
  );
}

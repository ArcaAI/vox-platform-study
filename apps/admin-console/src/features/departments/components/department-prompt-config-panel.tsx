'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { IconArrowRight, IconPencil } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useDepartment, usePromptTemplateOptions, useUpdateDepartmentPromptConfig } from '../api/hooks';
import type { Department, PromptTemplateOption, UpdateDepartmentPromptConfigRequest } from '../api/types';

/** Radix Select reserves '', so "no prompt" maps through a sentinel. */
const NONE_SENTINEL = '__none__';

interface PromptConfigValues {
  preSummaryPromptId: string;
  newPatientPromptId: string;
  revisitPromptId: string;
  dnaWritingStylePromptId: string;
}

const PROMPT_FIELDS: { key: keyof PromptConfigValues; label: string }[] = [
  { key: 'preSummaryPromptId', label: 'Pre-summary' },
  { key: 'newPatientPromptId', label: 'New patient' },
  { key: 'revisitPromptId', label: 'Revisit' },
  { key: 'dnaWritingStylePromptId', label: 'DNA writing-style' },
];

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function toPromptValues(department: Department): PromptConfigValues {
  return {
    preSummaryPromptId: department.preSummaryPromptId ?? '',
    newPatientPromptId: department.newPatientPromptId ?? '',
    revisitPromptId: department.revisitPromptId ?? '',
    dnaWritingStylePromptId: department.dnaWritingStylePromptId ?? '',
  };
}

/** Only slots that drifted from the loaded row go on the wire (a no-change PATCH 400s). */
function toPromptPatch(values: PromptConfigValues, department: Department): UpdateDepartmentPromptConfigRequest {
  const patch: UpdateDepartmentPromptConfigRequest = {};
  const current = toPromptValues(department);
  for (const key of Object.keys(current) as (keyof PromptConfigValues)[]) {
    if (values[key] !== current[key]) patch[key] = values[key];
  }
  return patch;
}

function PromptConfigForm({
  department,
  etag,
  options,
  onReloadLatest,
}: {
  department: Department;
  etag: string;
  options: PromptTemplateOption[];
  onReloadLatest: () => void;
}) {
  const uid = useId();
  const updatePromptConfig = useUpdateDepartmentPromptConfig();
  const [values, setValues] = useState<PromptConfigValues>(() => toPromptValues(department));

  const patch = toPromptPatch(values, department);
  const dirty = Object.keys(patch).length > 0;

  function set(key: keyof PromptConfigValues, next: string) {
    setValues((current) => ({ ...current, [key]: next === NONE_SENTINEL ? '' : next }));
  }

  function handleReloadLatest() {
    // Local selections are kept (the OCC alert promises no silent loss);
    // reloading refreshes the row version behind the next save.
    updatePromptConfig.reset();
    onReloadLatest();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    updatePromptConfig.mutate(
      { id: department.id, patch, etag },
      {
        onSuccess: () => toast.success('Prompt config updated'),
        onError: (error) => {
          if (!isOccError(error)) toast.error(error instanceof GatewayError ? error.message : 'Could not update the prompt config.');
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <OccConflictAlert error={updatePromptConfig.error} onReload={handleReloadLatest} />
      {PROMPT_FIELDS.map((field) => (
        <div key={field.key} className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-${field.key}`}>{field.label}</Label>
          <Select name={field.key} value={values[field.key] || NONE_SENTINEL} onValueChange={(next) => set(field.key, next)}>
            <SelectTrigger id={`${uid}-${field.key}`} aria-label={field.label} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_SENTINEL}>
                {'—'} None {'—'}
              </SelectItem>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!dirty || updatePromptConfig.isPending}>
          {updatePromptConfig.isPending ? <Spinner /> : null}
          Save prompt config
        </Button>
      </div>
    </form>
  );
}

/** Skeleton mirroring the four prompt Selects (rule 10). */
function PromptConfigSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Frame 30 third pane — the selected department's prompt config. Each of the
 * four slots (Pre-summary / New patient / Revisit / DNA writing-style) is a
 * Select over the tenant's prompt templates (plus "— None —"); saving PATCHes
 * only the drifted slots on the department's own :id/prompt-config OCC route.
 * The header carries the Edit affordance that opens the department DetailDrawer.
 *
 * TASK-719 Task 19 (owner verdict, `consolidation-map.md`): this panel stays the AUTHORITATIVE
 * editor for these four slots — per-department workflow assignment is TASK-733 and the
 * consultation palette is TASK-731, so folding into Workflow Studio does not fold in v1. A plain
 * `href` link to `/workflow-studio` is added here (reciprocal to the Studio's own
 * `PromptTemplatePicker` deep link back to `/prompt-templates`) so the two surfaces are
 * discoverable from each other, per rule 13's one-authoritative-editor-per-resource rule — never
 * a cross-feature import.
 */
export function DepartmentPromptConfigPanel({ departmentId, onEdit }: { departmentId: string; onEdit: () => void }) {
  const detail = useDepartment(departmentId);
  const templates = usePromptTemplateOptions();
  const department = detail.data?.data ?? null;

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-medium">Prompt config</h2>
          <p aria-hidden className="text-muted-foreground font-mono text-xs">
            PATCH :id/prompt-config
          </p>
          <p className="text-muted-foreground text-xs">
            Graph-based authoring is moving to{' '}
            <Link href="/workflow-studio" className="text-foreground inline-flex items-center gap-0.5 hover:underline">
              Workflow Studio
              <IconArrowRight aria-hidden className="size-3" />
            </Link>
            . These four slots stay the authoritative editor for now.
          </p>
        </div>
        {department ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <IconPencil aria-hidden />
            Edit
          </Button>
        ) : null}
      </div>
      {detail.isPending ? (
        <PromptConfigSkeleton />
      ) : detail.error || !department ? (
        <ErrorState
          error={detail.error ?? new GatewayError(404, 'This department does not exist or is outside your tenant scope.')}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <PromptConfigForm
          key={department.id}
          department={department}
          etag={detail.data?.etag ?? ''}
          options={templates.data ?? []}
          onReloadLatest={() => void detail.refetch()}
        />
      )}
    </Card>
  );
}

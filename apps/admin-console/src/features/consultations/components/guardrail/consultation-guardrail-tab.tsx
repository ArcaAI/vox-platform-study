'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconEye, IconShieldCheck } from '@tabler/icons-react';
import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { GUARDRAIL_CHECK_IDS, GUARDRAIL_DECISIONS, GUARDRAIL_DIRECTIONS } from '@arcaai/types';
import type { ColumnDef, DataQueryState } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { AdminDataGrid } from '@/shared/data/admin-data-grid';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { GuardrailNoticeList } from '@/shared/guardrail/guardrail-notice-list';
import { guardrailCategoryLabel, guardrailCheckLabel, guardrailDecisionMeta, guardrailDirectionShortLabel } from '@/shared/guardrail/labels';
import { EmptyState } from '@/shared/state/empty-state';
import {
  useAcknowledgeConsultationNotice,
  useConsultationGuardrailNotices,
  useGuardrailEvaluations,
  useWithheldContent,
  type GuardrailEvaluationCheck,
  type GuardrailEvaluationRow,
  type GuardrailWithheldContent,
} from '../../api/guardrail';

const PAGE_SIZE = 50;

/** Shareable filter state (rule 13: data-grid filters live in the URL). Namespaced so the activity params never collide. */
const FILTER_PARSERS = {
  gAction: parseAsStringLiteral(GUARDRAIL_DECISIONS),
  gDirection: parseAsStringLiteral(GUARDRAIL_DIRECTIONS),
  gCheck: parseAsString,
};

const DECISION_OPTION_LABELS: Record<string, string> = { allow: 'Allowed', warn: 'Warned', block: 'Blocked', unverified: 'Unverified' };

function flagged(row: GuardrailEvaluationRow): GuardrailEvaluationCheck[] {
  return row.checks.filter((check) => check.verdict === 'flag' || check.verdict === 'undetermined');
}

function maxConfidence(checks: readonly GuardrailEvaluationCheck[]): number | null {
  const values = checks.map((check) => check.confidence).filter((value): value is number => typeof value === 'number');
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * TASK-1050 W3b — consultation details → Guardrail: every guardrail evaluation of this consultation
 * (one per request × direction, newest first, keyset-paged) and its notices. Verdicts, models and ids
 * only — never content and never judge reasoning (README §9.6). The output an outbound block WITHHELD
 * is the one PHI read here: on request, audited, and only for platform / tenant administrators.
 */
export function ConsultationGuardrailTab({ consultationId }: { consultationId: string }) {
  const [filters, setFilters] = useQueryStates(FILTER_PARSERS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [withheldForbidden, setWithheldForbidden] = useState(false);
  const [withheld, setWithheld] = useState<GuardrailWithheldContent | null>(null);
  const [withheldPendingId, setWithheldPendingId] = useState<string | null>(null);

  const params = useMemo(
    () => ({
      ...(filters.gAction ? { action: filters.gAction } : {}),
      ...(filters.gDirection ? { direction: filters.gDirection } : {}),
      ...(filters.gCheck ? { check: filters.gCheck } : {}),
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    }),
    [filters, cursor],
  );
  const evaluations = useGuardrailEvaluations(consultationId, params);
  const notices = useConsultationGuardrailNotices(consultationId);
  const acknowledge = useAcknowledgeConsultationNotice(consultationId);
  const withheldRead = useWithheldContent(consultationId);

  const queryState = useMemo<DataQueryState>(
    () => ({ pagination: { mode: 'cursor', cursor, limit: PAGE_SIZE }, sorting: [], filters: [] }),
    [cursor],
  );

  function setFilter(next: Partial<typeof filters>) {
    setCursor(null);
    void setFilters(next);
  }

  function viewWithheld(evaluationId: string) {
    setWithheldPendingId(evaluationId);
    withheldRead.mutate(evaluationId, {
      onSuccess: setWithheld,
      onError: (error) => {
        if (error instanceof GatewayError && error.status === 403) setWithheldForbidden(true);
        else toast.error(error instanceof Error ? error.message : 'Could not read the withheld output');
      },
      onSettled: () => setWithheldPendingId(null),
    });
  }

  const columns = useMemo<ColumnDef<GuardrailEvaluationRow>[]>(
    () => [
      {
        accessorKey: 'at',
        header: 'Time',
        enableSorting: false,
        meta: { label: 'Time' },
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatDateTime(row.original.at)}</span>,
        size: 170,
      },
      {
        accessorKey: 'direction',
        header: 'Direction',
        enableSorting: false,
        meta: { label: 'Direction' },
        cell: ({ row }) => guardrailDirectionShortLabel(row.original.direction),
        size: 110,
      },
      {
        id: 'check',
        header: 'Check',
        enableSorting: false,
        meta: { label: 'Check' },
        cell: ({ row }) => {
          const hits = flagged(row.original);
          return hits.length > 0 ? (
            <span className="flex flex-col gap-0.5">
              {hits.map((check) => (
                <span key={check.checkId}>{guardrailCheckLabel(check.checkId)}</span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">{`All ${row.original.checks.length} passed`}</span>
          );
        },
        size: 200,
      },
      {
        accessorKey: 'decision',
        header: 'Action taken',
        enableSorting: false,
        meta: { label: 'Action taken' },
        cell: ({ row }) => {
          const meta = guardrailDecisionMeta(row.original.decision);
          return <StatusBadge label={meta.label} colorRole={meta.role} />;
        },
        size: 130,
      },
      {
        id: 'category',
        header: 'Category',
        enableSorting: false,
        meta: { label: 'Category' },
        cell: ({ row }) => {
          const categories = flagged(row.original).flatMap((check) => (check.category ? [guardrailCategoryLabel(check.category)] : []));
          return categories.length > 0 ? categories.join(', ') : <span className="text-muted-foreground">—</span>;
        },
        size: 160,
      },
      {
        id: 'confidence',
        header: 'Confidence',
        enableSorting: false,
        meta: { label: 'Confidence' },
        cell: ({ row }) => {
          const confidence = maxConfidence(flagged(row.original));
          return confidence === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="tabular-nums">{`${Math.round(confidence * 100)}%`}</span>
          );
        },
        size: 110,
      },
      {
        id: 'items',
        header: 'Region / item',
        enableSorting: false,
        meta: { label: 'Region / item' },
        cell: ({ row }) => {
          const regions = [...new Set(row.original.checks.flatMap((check) => check.regionKeys))];
          const items = [...new Set(row.original.checks.flatMap((check) => check.items.map((item) => `${item.itemId}@v${item.itemVersion}`)))];
          return (
            <span className="flex flex-col gap-0.5 font-mono text-xs">
              {regions.length > 0 ? <span>{regions.join(', ')}</span> : null}
              {items.length > 0 ? (
                <span className="text-muted-foreground truncate" title={items.join(', ')}>
                  {items.join(', ')}
                </span>
              ) : null}
            </span>
          );
        },
        size: 200,
      },
      {
        id: 'run',
        header: 'Run',
        enableSorting: false,
        meta: { label: 'Run' },
        cell: ({ row }) =>
          row.original.runId ? (
            <Link href={`/workflow-runs/${encodeURIComponent(row.original.runId)}`} className="font-mono text-xs underline underline-offset-2">
              {row.original.runId}
            </Link>
          ) : (
            <span className="text-muted-foreground font-mono text-xs">{row.original.caller}</span>
          ),
        size: 180,
      },
      {
        id: 'withheld',
        header: 'Withheld',
        enableSorting: false,
        enableResizing: false,
        meta: { label: 'Withheld' },
        cell: ({ row }) =>
          row.original.hasWithheldContent && !withheldForbidden ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={withheldPendingId !== null}
              onClick={(event) => {
                event.stopPropagation();
                viewWithheld(row.original.evaluationId);
              }}
            >
              {withheldPendingId === row.original.evaluationId ? <Spinner /> : <IconEye aria-hidden />}
              View withheld output
            </Button>
          ) : row.original.hasWithheldContent ? (
            <span className="text-muted-foreground text-xs">Withheld</span>
          ) : null,
        size: 200,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `viewWithheld` closes over the mutation, which is stable per mount
    [withheldForbidden, withheldPendingId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <section aria-label="Guardrail notices" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Notices</h2>
        {notices.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : notices.isError ? (
          <p className="text-muted-foreground text-sm">The notices could not be read.</p>
        ) : (
          <GuardrailNoticeList
            notices={notices.data}
            pendingNoticeId={acknowledge.isPending ? (acknowledge.variables ?? null) : null}
            onAcknowledge={(noticeId) =>
              acknowledge.mutate(noticeId, {
                onSuccess: () => toast.success('Warning acknowledged'),
                onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not acknowledge the warning'),
              })
            }
          />
        )}
      </section>

      <section aria-label="Guardrail evaluations" className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="me-auto text-sm font-semibold">Evaluations</h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="guardrail-filter-action">Action</Label>
            <NativeSelect
              id="guardrail-filter-action"
              value={filters.gAction ?? ''}
              onChange={(event) => setFilter({ gAction: (event.target.value || null) as (typeof GUARDRAIL_DECISIONS)[number] | null })}
            >
              <NativeSelectOption value="">All actions</NativeSelectOption>
              {GUARDRAIL_DECISIONS.map((decision) => (
                <NativeSelectOption key={decision} value={decision}>
                  {DECISION_OPTION_LABELS[decision] ?? decision}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="guardrail-filter-direction">Direction</Label>
            <NativeSelect
              id="guardrail-filter-direction"
              value={filters.gDirection ?? ''}
              onChange={(event) => setFilter({ gDirection: (event.target.value || null) as (typeof GUARDRAIL_DIRECTIONS)[number] | null })}
            >
              <NativeSelectOption value="">Both directions</NativeSelectOption>
              {GUARDRAIL_DIRECTIONS.map((direction) => (
                <NativeSelectOption key={direction} value={direction}>
                  {guardrailDirectionShortLabel(direction)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="guardrail-filter-check">Check</Label>
            <NativeSelect
              id="guardrail-filter-check"
              value={filters.gCheck ?? ''}
              onChange={(event) => setFilter({ gCheck: event.target.value || null })}
            >
              <NativeSelectOption value="">All checks</NativeSelectOption>
              {GUARDRAIL_CHECK_IDS.map((checkId) => (
                <NativeSelectOption key={checkId} value={checkId}>
                  {guardrailCheckLabel(checkId)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        {withheldForbidden ? (
          <p role="note" className="text-muted-foreground text-sm">
            Only super administrators and tenant administrators of this tenant can view withheld output, because it can quote patient data. Your
            account cannot view it.
          </p>
        ) : null}
        <AdminDataGrid<GuardrailEvaluationRow>
          gridId="consultation-guardrail-evaluations"
          aria-label="Guardrail evaluations"
          columns={columns}
          rows={evaluations.data?.items ?? []}
          total={evaluations.data?.items.length ?? 0}
          queryState={queryState}
          onQueryStateChange={(next) => setCursor(next.pagination.mode === 'cursor' ? (next.pagination.cursor ?? null) : null)}
          pageMode="cursor"
          cursor={{ hasMore: evaluations.data?.hasMore, nextCursor: evaluations.data?.nextCursor }}
          isLoading={evaluations.isLoading}
          isBusy={evaluations.isFetching && !evaluations.isLoading}
          error={evaluations.error ?? undefined}
          onRetry={() => void evaluations.refetch()}
          getRowId={(row) => row.evaluationId}
          emptyState={
            <EmptyState
              icon={IconShieldCheck}
              title="No guardrail evaluations yet"
              description="Each text generation for this consultation records its guardrail result here, clean ones included."
            />
          }
        />
      </section>

      <DetailDrawer
        open={withheld !== null}
        onOpenChange={(open) => !open && setWithheld(null)}
        title="Withheld output"
        meta={withheld ? <span className="font-mono text-xs">{`${withheld.evaluationId} · ${formatDateTime(withheld.at)}`}</span> : null}
      >
        {withheld ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">
              A guardrail block kept this generation from the clinician. It is shown here for false-positive review; this read is audited.
            </p>
            <pre className="bg-muted/40 rounded-md border p-3 text-sm whitespace-pre-wrap">{withheld.content}</pre>
          </div>
        ) : null}
      </DetailDrawer>
    </div>
  );
}

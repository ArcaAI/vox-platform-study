'use client';

import { useState } from 'react';
import { IconRefresh } from '@tabler/icons-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { harnessOpsKeys, useHarnessAudit } from '../api';
import type { HarnessAuditAction } from '../api';
import { ChainIntegrityCard } from './chain-integrity-card';
import { EditBurdenCard } from './edit-burden-card';
import { EvalRunsPanel } from './eval-runs-panel';
import { GateEditExemplarsPanel } from './gate-edit-exemplars-panel';
import { GateQueueCard } from './gate-queue-card';
import { GoldenSetsPanel } from './golden-sets-panel';

/** HarnessAuditAction enum values — the audit `action` filter is server-side. */
const AUDIT_ACTIONS: HarnessAuditAction[] = [
  'GENERATE',
  'SENSOR_RUN',
  'GATE_DECISION',
  'ATTEST',
  'CONSENT_GIVEN',
  'CONSENT_WITHDRAWN',
  'BREACH_REPORTED',
  'REDUCED_ASSURANCE',
  'SAFETY_OVERRIDE',
  'SIGNED_BEFORE_ASSURANCE',
  'POST_SIGN_FLAG',
];

const ACTION_OPTIONS: FilterOption[] = AUDIT_ACTIONS.map((action) => ({ value: action, label: action }));

/** The audit endpoint takes ISO `from`/`to` bounds; the range select maps to `from`. */
const RANGE_MS: Record<string, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

const RANGE_OPTIONS: FilterOption[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];

const AUDIT_PAGE_SIZE = 50;

const META_DESCRIPTION = 'Read-only \u00b7 WORM audit trail + eval runs + clinician gate queue';

function ObservabilityBody() {
  const queryClient = useQueryClient();
  const [{ search, action, range }, setParams] = useQueryStates({
    search: parseAsString.withDefault(''),
    action: parseAsString.withDefault(''),
    range: parseAsString.withDefault('7d'),
  });

  // Clock anchored once per mount (lazy initializer keeps render pure): a
  // Date.now() read in render would rotate the query key (and refetch)
  // every pass. Refresh/invalidate refetches within the anchored window.
  const [anchorMs] = useState(() => Date.now());
  const windowMs = RANGE_MS[range];
  const from = windowMs ? new Date(anchorMs - windowMs).toISOString() : undefined;

  const auditQuery = useHarnessAudit({ action: action || undefined, from, limit: AUDIT_PAGE_SIZE });

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Harness Observability"
          meta={
            <>
              <span>{META_DESCRIPTION}</span>
              <span aria-hidden className="text-muted-foreground font-mono text-xs">
                GET /admin/harness/audit
              </span>
            </>
          }
          actions={
            <Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: harnessOpsKeys.root })}>
              <IconRefresh aria-hidden />
              Refresh
            </Button>
          }
        />
      }
      toolbar={
        <FilterBar>
          <FilterSearch
            label="Search audit rows"
            placeholder={'Search audit\u2026'}
            value={search}
            onChange={(value) => setParams({ search: value || null })}
          />
          <FilterSelect
            id="harness-audit-action-filter"
            label="Type"
            value={action}
            onChange={(value) => setParams({ action: value || null })}
            options={ACTION_OPTIONS}
          />
          <FilterSelect
            id="harness-audit-range-filter"
            label="Range"
            value={range === 'all' ? '' : range}
            onChange={(value) => setParams({ range: value === '' ? 'all' : value === '7d' ? null : value })}
            options={RANGE_OPTIONS}
            allLabel="All time"
          />
          <span aria-hidden className="text-muted-foreground ml-auto pr-2 font-mono text-xs">
            ?tenantId= is platform-only
          </span>
        </FilterBar>
      }
    >
      <div className="grid gap-4 xl:grid-cols-3">
        <ChainIntegrityCard
          data={auditQuery.data}
          isLoading={auditQuery.isLoading}
          error={auditQuery.error}
          onRetry={() => void auditQuery.refetch()}
          search={search}
        />
        <EvalRunsPanel />
        <GateQueueCard />
        {/* (M-09 tenant leg) — golden datasets + per-consultation
            edit-burden telemetry; both are PHI-safe metadata/derived scalars. */}
        <GoldenSetsPanel />
        <EditBurdenCard />
        {/* GAP-A1 candidate stream — clinician approve-vs-edit signal, with the
            "promote to golden case" affordance. */}
        <GateEditExemplarsPanel />
      </div>
    </ScreenTemplate>
  );
}

/** Frame 37 — Harness observability: WORM audit + evals + gate queue (tier 30–49). */
export function HarnessObservabilityScreen() {
  return (
    <WorkingTenantGate
      title="Harness Observability"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/harness/audit
        </span>
      }
      description="Harness observability is tenant-scoped. Pick a working tenant from the switcher in the top bar to load its WORM audit trail, eval runs and gate queue."
    >
      <ObservabilityBody />
    </WorkingTenantGate>
  );
}

'use client';

import { Fragment, useId, type ReactNode } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useGuardrailConfig, useGuardrailStatus } from '../api';

/**
 * ⚠ DEFENSIVE RENDERING — READ BEFORE EDITING.
 *
 * Everything below `UpstreamDocument` renders documents whose shape is owned
 * by the guardrail/NLP Python services and proxied through the gateway
 * verbatim. The console never validates or narrows them: it recognizes
 * status-ish fields well enough to badge them, and falls back to a readable
 * key/value tree for everything else. An upstream field rename, a new nested
 * object, or a null where a string used to be must DEGRADE this panel, not
 * crash the screen — so no zod schema, no required-field assumptions, and no
 * non-null assertions are permitted here.
 *
 * Exported so `nlp-panel.tsx` renders its (equally upstream-owned) health
 * document through exactly the same path.
 */

/** Keys whose string value we treat as a health signal worth badging. */
const STATUS_KEYS = new Set(['status', 'state', 'health']);

const HEALTHY = new Set(['healthy', 'ok', 'up', 'ready', 'pass', 'passing', 'available', 'online']);
const UNHEALTHY = new Set(['unhealthy', 'error', 'down', 'fail', 'failing', 'unavailable', 'offline']);
const DEGRADED = new Set(['degraded', 'warning', 'warn', 'partial', 'starting', 'loading', 'pending']);

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

/** Best-effort mapping of an upstream status string to a badge variant. */
function statusVariant(value: string): BadgeVariant {
  const normalized = value.trim().toLowerCase();
  if (HEALTHY.has(normalized)) return 'default';
  if (UNHEALTHY.has(normalized)) return 'destructive';
  if (DEGRADED.has(normalized)) return 'secondary';
  // Unrecognized vocabulary still reads as a status, just a neutral one.
  return 'outline';
}

function isStatusField(key: string, value: unknown): value is string {
  return typeof value === 'string' && STATUS_KEYS.has(key.trim().toLowerCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scalar/array leaf. Never throws: anything unprintable becomes JSON or a dash. */
function LeafValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">{'—'}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">empty</span>;
    return <>{value.map((entry) => (isPlainRecord(entry) ? JSON.stringify(entry) : String(entry))).join(', ')}</>;
  }
  if (typeof value === 'boolean') return <>{value ? 'true' : 'false'}</>;
  if (typeof value === 'object') return <>{JSON.stringify(value)}</>;
  return <>{String(value)}</>;
}

/**
 * Recursive key/value tree over an upstream document. Nested objects become
 * nested definition lists (valid inside `<dd>`), so arbitrarily shaped health
 * documents stay readable and screen-reader navigable.
 */
export function UpstreamDocument({ document, className }: { document: Record<string, unknown>; className?: string }) {
  const entries = Object.entries(document);
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">The service returned an empty document.</p>;
  }
  return (
    <dl className={className ?? 'grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5'}>
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground font-mono text-xs break-all">{key}</dt>
          <dd className="min-w-0 font-mono text-xs">
            {isStatusField(key, value) ? (
              <Badge variant={statusVariant(value)}>{value}</Badge>
            ) : isPlainRecord(value) ? (
              <div className="border-border/60 flex flex-col gap-1 border-l pl-3">
                <UpstreamDocument document={value} />
              </div>
            ) : (
              <LeafValue value={value} />
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Skeleton mirroring a loaded key/value document (rule 10 — shape, not spinner). */
export function DocumentSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/**
 * A titled card wrapping one upstream document, exposed as a landmark region
 * so tests and screen readers can address each document independently.
 */
export function DocumentCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const uid = useId();
  return (
    <Card className="gap-3 p-4">
      <section className="flex flex-col gap-3" aria-labelledby={`${uid}-title`}>
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-title`} className="text-sm font-medium">
            {title}
          </h2>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
        {children}
      </section>
    </Card>
  );
}

/**
 * Guardrail tab: the service's health document plus its two read-only config
 * documents. Both reads are independent — a failed status read must not hide
 * a config that loaded fine, so each renders its own error state with retry.
 */
export function GuardrailPanel() {
  const statusQuery = useGuardrailStatus();
  const configQuery = useGuardrailConfig();

  return (
    <div className="flex flex-col gap-4">
      {statusQuery.isPending ? (
        <DocumentCard title="Guardrail service status">
          <DocumentSkeleton />
        </DocumentCard>
      ) : statusQuery.error || !statusQuery.data ? (
        <ErrorState title="Couldn’t load the guardrail status" error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
      ) : (
        <DocumentCard
          title="Guardrail service status"
          description="Proxied verbatim from the guardrail service (GET /api/health). Component checks: LLM engine, GLiNER, Redis."
        >
          <UpstreamDocument document={statusQuery.data} />
        </DocumentCard>
      )}

      {configQuery.isPending ? (
        <DocumentCard title="Guardrail configuration">
          <DocumentSkeleton rows={4} />
        </DocumentCard>
      ) : configQuery.error || !configQuery.data ? (
        <ErrorState title="Couldn’t load the guardrail configuration" error={configQuery.error} onRetry={() => void configQuery.refetch()} />
      ) : (
        <DocumentCard
          title="Guardrail configuration"
          description="Read-only: medical-validation engine settings and supported analysis types. Config changes are deploy-time settings on the service."
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h3 className="text-muted-foreground text-xs font-medium uppercase">Medical validation</h3>
              <UpstreamDocument document={configQuery.data.medicalValidation} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-muted-foreground text-xs font-medium uppercase">Analysis types</h3>
              <UpstreamDocument document={configQuery.data.analysisTypes} />
            </div>
          </div>
        </DocumentCard>
      )}
    </div>
  );
}

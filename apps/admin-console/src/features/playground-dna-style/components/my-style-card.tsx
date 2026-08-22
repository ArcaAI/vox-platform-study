'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { IconBolt, IconDna } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDnaSettings, useMyStyle, useUpdateMyReport } from '../api';
import type { DnaReport } from '../api';

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * PATCH :reportId editor for the DTO's editable fields (styleText +
 * changeReason). If-Match carries the read ETag; a 412 renders the
 * OccConflictAlert with the draft kept locally.
 */
function StyleEditor({ report, etag, onDone, onReload }: { report: DnaReport; etag: string; onDone: () => void; onReload: () => void }) {
  const update = useUpdateMyReport();
  const [styleText, setStyleText] = useState(report.styleText ?? '');
  const [changeReason, setChangeReason] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate(
      { reportId: report.id, patch: { styleText, ...(changeReason.trim() ? { changeReason: changeReason.trim() } : {}) }, etag },
      {
        onSuccess: () => {
          toast.success('Style updated');
          onDone();
        },
        onError: (error) => {
          // OCC failures render inline below; anything else toasts.
          if (!isOccError(error)) {
            toast.error(error instanceof GatewayError ? error.message : 'Could not update the style.');
          }
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <OccConflictAlert
        error={update.error}
        onReload={() => {
          update.reset();
          onReload();
        }}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="playground-dna-style-text">Style text</Label>
        <Textarea
          id="playground-dna-style-text"
          value={styleText}
          onChange={(event) => setStyleText(event.target.value)}
          rows={6}
          className="resize-none text-sm"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="playground-dna-change-reason">Edit reason</Label>
        <Input
          id="playground-dna-change-reason"
          value={changeReason}
          onChange={(event) => setChangeReason(event.target.value)}
          placeholder="Why this edit (kept in the version history)"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? <Spinner /> : null}
          Save style
        </Button>
      </div>
    </form>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Fallback rendering when the analysis produced structured data but no prose. */
function reportDataSummary(reportData: Record<string, unknown> | undefined): string | null {
  if (!reportData || Object.keys(reportData).length === 0) return null;
  try {
    return JSON.stringify(reportData, null, 2);
  } catch {
    return null;
  }
}

/**
 * Frame 53 — the caller's current style (GET /my-style, kept WithEtag for
 * the OCC PATCH). A 404 is the DESIGNED "no style yet" empty state with the
 * generate CTA (disabled behind the doctor gate), never an error card.
 */
export function MyStyleCard({
  myStyle,
  settings,
  gated,
  onGenerate,
  generatePending,
}: {
  myStyle: ReturnType<typeof useMyStyle>;
  settings: ReturnType<typeof useDnaSettings>;
  gated: boolean;
  onGenerate: () => void;
  generatePending: boolean;
}) {
  const [editing, setEditing] = useState(false);

  const payload = myStyle.data?.data;
  // ETag preferred; the DTO's OCC `version` field backs it up (the gateway
  // ETagInterceptor mirrors `_version`, so both carry the same token).
  const etag = myStyle.data?.etag ?? (payload ? `"${payload.version}"` : null);

  let body: ReactNode;
  if (myStyle.isPending) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (myStyle.isError) {
    body =
      myStyle.error instanceof GatewayError && myStyle.error.isNotFound ? (
        <EmptyState
          icon={IconDna}
          title="No DNA style yet"
          description="No DNA writing-style report exists for this account. Generate the first one from your notes or pasted text samples."
          action={
            <div className="flex flex-col items-center gap-1.5">
              <Button onClick={onGenerate} disabled={gated || generatePending}>
                {generatePending ? <Spinner /> : <IconBolt aria-hidden />}
                Generate my style
              </Button>
              {gated ? <span className="text-muted-foreground text-xs">Requires acting as a doctor</span> : null}
            </div>
          }
        />
      ) : (
        <ErrorState error={myStyle.error} onRetry={() => void myStyle.refetch()} />
      );
  } else if (payload) {
    const dataSummary = reportDataSummary(payload.reportData);
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <DetailRow label="Report">
            <span className="font-mono text-xs break-all">{payload.id}</span>
          </DetailRow>
          <DetailRow label="Version">
            <span className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">v{payload.currentVersionNumber}</span>
              {payload.isLatest ? <Badge variant="secondary">Default</Badge> : null}
            </span>
          </DetailRow>
          <DetailRow label="Updated">
            <span className="text-muted-foreground">{formatRelativeTime(payload.updatedAt)}</span>
          </DetailRow>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium">Style text</h3>
            {!editing ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!etag}>
                Edit
              </Button>
            ) : null}
          </div>
          {editing && etag ? (
            <StyleEditor report={payload} etag={etag} onDone={() => setEditing(false)} onReload={() => void myStyle.refetch()} />
          ) : payload.styleText ? (
            <p className="text-muted-foreground line-clamp-6 text-sm whitespace-pre-wrap">{payload.styleText}</p>
          ) : dataSummary ? (
            <pre className="text-muted-foreground bg-muted max-h-48 overflow-y-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
              {dataSummary}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm">No style text extracted.</p>
          )}
        </div>
      </div>
    );
  } else {
    body = null;
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-medium">My writing style</h2>
        <CardAction>
          <span className="flex items-center gap-2">
            {settings.data ? (
              <StatusBadge label={`DNA ${settings.data.effective ? 'ON' : 'OFF'}`} colorRole={settings.data.effective ? 'success' : 'neutral'} />
            ) : null}
            <span aria-hidden className="text-muted-foreground font-mono text-xs">
              GET /my-style
            </span>
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

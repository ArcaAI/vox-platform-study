'use client';

import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/components/shadcn/sheet';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime } from '@/shared/format';
import type { AuditLog } from '../api/types';
import { AuditResultIndicator } from './audit-result-indicator';

const PRE_CLASS = 'bg-muted max-h-72 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap';

function JsonSection({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value, null, 4) ?? 'null';
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <CopyButton value={json} label={`Copy ${title.toLowerCase()}`} />
      </div>
      <pre className={PRE_CLASS}>{json}</pre>
    </section>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

const EM_DASH = '\u2014';

/**
 * Row-click drawer per frame 18: the full audit record — actor, ip,
 * before/after JSON — read-only (matrix: no edit/delete anywhere).
 */
export function AuditLogDetailSheet({ log, onOpenChange }: { log: AuditLog | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={log !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-1 font-mono text-sm break-all">
            {log?.id}
            {log ? <CopyButton value={log.id} label="Copy audit log id" /> : null}
          </SheetTitle>
          <SheetDescription>Full audit record — read-only.</SheetDescription>
        </SheetHeader>
        {log ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <MetaItem label="Time">
                <span title={log.createdAt}>{formatDateTime(log.createdAt)}</span>
              </MetaItem>
              <MetaItem label="Result">
                <AuditResultIndicator success={log.success} />
              </MetaItem>
              <MetaItem label="Action">
                <span className="font-mono text-xs">{log.action}</span>
              </MetaItem>
              <MetaItem label="Event type">{log.eventType ? <span className="font-mono text-xs">{log.eventType}</span> : EM_DASH}</MetaItem>
              <MetaItem label="Actor">{log.responsibleUser?.email ?? log.responsibleUser?.displayName ?? log.responsibleUserId ?? 'system'}</MetaItem>
              <MetaItem label="Actor user id">
                {log.responsibleUserId ? (
                  <span className="inline-flex items-center gap-1 font-mono text-xs">
                    {log.responsibleUserId}
                    <CopyButton value={log.responsibleUserId} label="Copy actor user id" />
                  </span>
                ) : (
                  EM_DASH
                )}
              </MetaItem>
              <MetaItem label="IP">{log.responsibleIp ? <span className="font-mono text-xs">{log.responsibleIp}</span> : EM_DASH}</MetaItem>
              <MetaItem label="Tenant">
                <span className="font-mono text-xs">{log.tenantId}</span>
              </MetaItem>
              <MetaItem label="Resource type">
                <span className="font-mono text-xs">{log.resourceType}</span>
              </MetaItem>
              <MetaItem label="Resource id">
                {log.resourceId ? (
                  <span className="inline-flex items-center gap-1 font-mono text-xs">
                    {log.resourceId}
                    <CopyButton value={log.resourceId} label="Copy resource id" />
                  </span>
                ) : (
                  EM_DASH
                )}
              </MetaItem>
            </dl>
            <JsonSection title="Data" value={log.data} />
            <JsonSection title="Previous data" value={log.previousData} />
            <JsonSection title="Metadata" value={log.metadata} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

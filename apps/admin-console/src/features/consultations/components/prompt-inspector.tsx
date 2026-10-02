'use client';

/**
 * Prompt Inspector — what an LLM call for this consultation is composed into, and what was sent.
 *
 *  - **Preview** (`POST admin/consultations/:id/prompt-preview`): a dry run of one phase through
 *    the platform's single composer, against the consultation's real context. Shows the composed
 *    messages next to the provider view (the pseudonymized text a cloud provider would receive;
 *    a local provider gets the composed text unchanged), the provider locality, the label COUNTS
 *    the egress detector found, the token estimate, which fragments were selected or excluded,
 *    and which data blocks were truncated to budget.
 *  - **Stored prompts** (`GET admin/composed-prompts?consultationId=`): the encrypted records of
 *    what was actually sent, listed as metadata; opening one decrypts it (an audited read).
 *
 * Read-only: nothing here changes the consultation or the agent.
 */
import { useId, useState } from 'react';
import { IconCloud, IconDatabaseOff, IconServer } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import {
  PROMPT_PREVIEW_PHASES,
  useComposedPrompt,
  useComposedPrompts,
  usePromptPreview,
  type PromptLocality,
  type PromptMessages,
  type PromptPreviewPhase,
  type PromptPreviewResponse,
} from '../api';

const PHASE_LABEL: Record<PromptPreviewPhase, string> = {
  live: 'Live',
  'pre-summary': 'Pre-summary',
  finalize: 'Finalize',
};

function LocalityBadge({ locality }: { locality: PromptLocality }) {
  return locality === 'cloud' ? (
    <Badge variant="outline" className="gap-1">
      <IconCloud aria-hidden className="size-3.5" />
      Cloud provider
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1">
      <IconServer aria-hidden className="size-3.5" />
      Local provider
    </Badge>
  );
}

function MessageBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h5 className="text-muted-foreground text-xs font-medium">{title}</h5>
      <pre className="bg-muted/40 max-h-80 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap break-words">{text || '—'}</pre>
    </div>
  );
}

function MessagesView({ label, messages }: { label: string; messages: PromptMessages }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-medium">{label}</h4>
      <MessageBlock title="System" text={messages.system} />
      <MessageBlock title="User" text={messages.user} />
    </section>
  );
}

function resolvedFromText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function PreviewResult({ preview }: { preview: PromptPreviewResponse }) {
  const detected = Object.entries(preview.egressPreview.detected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <LocalityBadge locality={preview.locality} />
        <span className="text-muted-foreground tabular-nums">
          ~{preview.tokenEstimate.system} system + {preview.tokenEstimate.user} user tokens
        </span>
        <span className="text-muted-foreground">
          Instruction from <span className="font-mono text-xs">{resolvedFromText(preview.resolvedFrom)}</span>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <h4 className="text-sm font-medium">PII / PHI detected</h4>
        {detected.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing detected.</p>
        ) : (
          <ul aria-label="Detected labels" className="flex flex-wrap gap-2">
            {detected.map(([label, count]) => (
              <li key={label} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
                <span className="font-mono">{label}</span>
                <span className="tabular-nums font-medium">{count}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          {preview.locality === 'cloud'
            ? `${preview.egressPreview.redacted} values redacted before the provider call; tokens are restored in the response.`
            : 'Detected and audited only — a local provider is not redacted.'}
        </p>
      </div>

      {preview.selected.length > 0 || preview.excluded.length > 0 ? (
        <div className="flex flex-col gap-1.5 text-sm">
          <h4 className="font-medium">Fragments</h4>
          <p>
            Selected: <span className="font-mono text-xs">{preview.selected.join(', ') || '—'}</span>
          </p>
          {preview.excluded.length > 0 ? (
            <ul aria-label="Excluded fragments" className="flex flex-col gap-0.5">
              {preview.excluded.map((exclusion) => (
                <li key={exclusion.key} className="text-muted-foreground text-xs">
                  <span className="font-mono">{exclusion.key}</span> — {exclusion.reason}
                  {exclusion.detail ? `: ${exclusion.detail}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {preview.blocks.length > 0 ? (
        <table aria-label="Data blocks" className="w-full text-left text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Block
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Characters
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Budget
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.blocks.map((block) => (
              <tr key={block.key} className="border-t">
                <td className="py-1 font-mono text-xs">{block.key}</td>
                <td className="py-1 text-right tabular-nums">{block.chars.toLocaleString()}</td>
                <td className="py-1 text-right">{block.truncated ? <Badge variant="destructive">Truncated</Badge> : <span className="text-muted-foreground text-xs">Within budget</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="@container">
        <div className="grid gap-4 @3xl:grid-cols-2">
          <MessagesView label="As composed" messages={preview} />
          {preview.providerView ? (
            <MessagesView label="Sent to the provider" messages={preview.providerView} />
          ) : (
            <section aria-label="Sent to the provider" className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">Sent to the provider</h4>
              <p className="text-muted-foreground text-sm">A local provider receives the composed prompt unchanged.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function StoredPrompts({ consultationId }: { consultationId: string }) {
  const records = useComposedPrompts(consultationId);
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = useComposedPrompt(openId);

  if (records.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }
  if (records.isError) return <ErrorState title={'Couldn’t load the stored prompts'} error={records.error} onRetry={() => void records.refetch()} />;
  if (records.data.length === 0) {
    return <EmptyState icon={IconDatabaseOff} title="No stored prompts" description="Nothing composed for this consultation has been recorded, or the records have passed retention." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <table aria-label="Stored prompts" className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th scope="col" className="py-1 font-medium">
              Created
            </th>
            <th scope="col" className="py-1 font-medium">
              Phase
            </th>
            <th scope="col" className="py-1 font-medium">
              Agent
            </th>
            <th scope="col" className="py-1 font-medium">
              Provider
            </th>
            <th scope="col" className="py-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.data.map((record) => (
            <tr key={record.id} className="border-t" aria-current={record.id === openId ? 'true' : undefined}>
              <td className="py-1 tabular-nums">{formatDateTime(record.createdAt)}</td>
              <td className="py-1">{record.phase}</td>
              <td className="py-1 font-mono text-xs">{record.agentSlug ?? '—'}</td>
              <td className="py-1">
                <span className="inline-flex items-center gap-2">
                  <span>{record.provider}</span>
                  <LocalityBadge locality={record.locality} />
                </span>
              </td>
              <td className="py-1 text-right">
                <Button type="button" variant="outline" size="sm" aria-label={`View prompt recorded ${formatDateTime(record.createdAt)}`} onClick={() => setOpenId(record.id)}>
                  View
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {openId ? (
        opened.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : opened.isError ? (
          <ErrorState title={'Couldn’t open this record'} error={opened.error} onRetry={() => void opened.refetch()} />
        ) : (
          <MessagesView label="Stored prompt" messages={opened.data} />
        )
      ) : null}
    </div>
  );
}

export function PromptInspector({ consultationId }: { consultationId: string }) {
  const uid = useId();
  const [phase, setPhase] = useState<PromptPreviewPhase>('live');
  const [agentSlug, setAgentSlug] = useState('');
  const preview = usePromptPreview(consultationId);

  function run() {
    const slug = agentSlug.trim();
    preview.mutate({ phase, ...(slug ? { agentSlug: slug } : {}) });
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${uid}-preview`} className="flex flex-col gap-3">
        <h3 id={`${uid}-preview`} className="text-sm font-medium">
          Preview a composed prompt
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-phase`}>Phase</Label>
            <Select value={phase} onValueChange={(next) => setPhase(next as PromptPreviewPhase)}>
              <SelectTrigger id={`${uid}-phase`} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROMPT_PREVIEW_PHASES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PHASE_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${uid}-agent`}>Agent slug (optional)</Label>
            <Input
              id={`${uid}-agent`}
              className="font-mono"
              value={agentSlug}
              placeholder="The phase's own agent when empty"
              autoComplete="off"
              onChange={(event) => setAgentSlug(event.target.value)}
            />
          </div>
          <Button type="button" onClick={run} disabled={preview.isPending}>
            {preview.isPending ? <Spinner /> : null}
            Preview prompt
          </Button>
        </div>
        {preview.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {preview.error instanceof GatewayError ? preview.error.message : 'Could not compose a preview.'}
          </p>
        ) : null}
        {preview.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : preview.data ? (
          <PreviewResult preview={preview.data} />
        ) : null}
      </section>

      <section aria-labelledby={`${uid}-stored`} className="flex flex-col gap-3 border-t pt-4">
        <h3 id={`${uid}-stored`} className="text-sm font-medium">
          Stored prompts
        </h3>
        <StoredPrompts consultationId={consultationId} />
      </section>
    </div>
  );
}

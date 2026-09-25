'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import type {
  LmStudioResidencyLoadOptions,
  ResidencyCatalogueModel,
  ResidencyDevice,
  ResidencyKeepPolicyKind,
  ResidencyServiceGroup,
} from '../api/types';
import { useSaveResidencyPolicy } from '../api/hooks';
import { deviceShortLabel, formatModelStatus, humanizeTaskLabel, keepPolicyKindToClass, primaryRowAction, USE_ROLE_LABEL } from './residency-display';

const EM_DASH = '—';

const KEEP_POLICY_OPTIONS: { value: ResidencyKeepPolicyKind; label: string; hint: string }[] = [
  { value: 'always', label: 'Always loaded', hint: 'Never unloaded by the controller.' },
  { value: 'warm', label: 'Keep warm', hint: 'Stays loaded until it has been idle past the minutes below.' },
  { value: 'on_demand', label: 'Load when needed', hint: 'Loads on the first request, unloads after the idle minutes below.' },
];

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export interface ModelDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  devices: ResidencyDevice[];
  actionPending: boolean;
  onLoad: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onUnload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onReload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel, options: LmStudioResidencyLoadOptions) => void;
}

/**
 * The one detail surface for a catalogue model (ticket §13.2): who uses it,
 * its measured/estimated footprint and load history, and the keep-policy
 * editor. Primary Load/Unload/Reload actions are repeated in the footer so an
 * admin who opened the drawer to review usage does not have to close it to
 * act — they call back to the SAME handlers the row buttons use, so the
 * force/reason confirmations (OD-3) are handled once, in the screen.
 */
export function ModelDetailDrawer({
  open,
  onOpenChange,
  service,
  model,
  devices,
  actionPending,
  onLoad,
  onUnload,
  onReload,
}: ModelDetailDrawerProps) {
  const savePolicy = useSaveResidencyPolicy();
  const [kind, setKind] = useState<ResidencyKeepPolicyKind>(model.keepPolicy.kind);
  const [idleMinutes, setIdleMinutes] = useState(
    model.keepPolicy.idleTtlSeconds === null ? '' : String(Math.round(model.keepPolicy.idleTtlSeconds / 60)),
  );
  const [contextLength, setContextLength] = useState('');
  const [flashAttention, setFlashAttention] = useState(false);

  // Re-seed the draft whenever a different model opens.
  const [seededFor, setSeededFor] = useState(model.aiModelId);
  if (open && seededFor !== model.aiModelId) {
    setSeededFor(model.aiModelId);
    setKind(model.keepPolicy.kind);
    setIdleMinutes(model.keepPolicy.idleTtlSeconds === null ? '' : String(Math.round(model.keepPolicy.idleTtlSeconds / 60)));
  }

  function savePolicyDraft() {
    // The drawer is only opened for a model that has a catalogue entry
    // (`service-section.tsx` hides "Details" for an orphan resident model),
    // so this is a defensive guard, not an expected path.
    if (!model.aiModelId) return;
    savePolicy.mutate(
      {
        aiModelId: model.aiModelId,
        service: service.service,
        policyId: model.keepPolicy.policyId,
        policyVersion: model.keepPolicy.policyVersion,
        class: keepPolicyKindToClass(kind),
        idleTtlSeconds: kind === 'always' || idleMinutes.trim() === '' ? null : Number(idleMinutes) * 60,
      },
      {
        onSuccess: () => toast.success(`Keep policy saved for ${model.name}.`),
        onError: () => toast.error(`Couldn't save the keep policy for ${model.name}.`),
      },
    );
  }

  // Mirrors `service-section.tsx`: a service with no control API (e.g. stt-worker) never offers a
  // primary action here either, regardless of what `model.actions` says.
  const action = service.controllable ? primaryRowAction(model.actions) : null;
  const isLmStudio = service.service === 'lm-studio';

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={model.name}
      badges={<Badge variant="outline">{service.label}</Badge>}
      meta={<span className="font-mono">{model.slug ?? model.modelRef}</span>}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {action === 'load' ? (
            <Button disabled={actionPending} onClick={() => onLoad(service, model)}>
              {actionPending ? <Spinner /> : null}
              Load
            </Button>
          ) : null}
          {action === 'unload' ? (
            <Button variant="destructive" disabled={actionPending} onClick={() => onUnload(service, model)}>
              {actionPending ? <Spinner /> : null}
              Unload
            </Button>
          ) : null}
          {action === 'reload' && isLmStudio ? (
            <Button
              disabled={actionPending}
              onClick={() =>
                onReload(service, model, {
                  ...(contextLength !== '' ? { contextLength: Number(contextLength) } : {}),
                  flashAttention,
                })
              }
            >
              {actionPending ? <Spinner /> : null}
              Reload with options
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Who uses it</h3>
          {model.usage.uses.length === 0 ? (
            <p className="text-muted-foreground text-sm">No agent uses it.</p>
          ) : (
            <div className="rounded-md border">
              <Table aria-label={`Agents and tenants using ${model.name}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Tenant</TableHead>
                    <TableHead scope="col">Agent</TableHead>
                    <TableHead scope="col">Task</TableHead>
                    <TableHead scope="col">Role</TableHead>
                    <TableHead scope="col">Live</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.usage.uses.map((use, index) => (
                    <TableRow key={`${use.tenantId}::${use.agentSlug ?? use.task}::${index}`}>
                      <TableCell>{use.tenantName}</TableCell>
                      {/* A routing-policy consumer (role `routing`, e.g. guardrail/NLP/judge) has no
                          agent — only a task and the policy. The Role column already says "Routing
                          policy"; this cell stays an em dash rather than the literal string "null". */}
                      <TableCell>{use.agentName ?? EM_DASH}</TableCell>
                      <TableCell>{humanizeTaskLabel(use.task)}</TableCell>
                      <TableCell>{USE_ROLE_LABEL[use.role]}</TableCell>
                      <TableCell>{use.liveConsultation ? <Badge variant="secondary">Live consultations</Badge> : EM_DASH}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Residency</h3>
          <p className="text-muted-foreground text-sm">{formatModelStatus(model, devices)}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Fact label="Device" value={model.residency ? deviceShortLabel(model.residency.device, devices) : EM_DASH} />
            <Fact
              label="Size"
              value={
                model.residency?.bytes != null
                  ? `${formatBytes(model.residency.bytes)} (${model.residency.bytesSource})`
                  : model.size.bytes != null
                    ? `${formatBytes(model.size.bytes)} (${model.size.source})`
                    : EM_DASH
              }
            />
            <Fact label="Load time" value={model.loadSeconds !== null ? `${formatNumber(Math.round(model.loadSeconds))} s` : EM_DASH} />
            <Fact label="In flight" value={model.residency ? formatNumber(model.residency.inFlight) : EM_DASH} />
            <Fact
              label="Requests / min"
              value={model.residency?.requestsPerMin != null ? formatNumber(Math.round(model.residency.requestsPerMin * 10) / 10) : EM_DASH}
            />
            <Fact label="p50 latency" value={model.residency?.p50LatencyMs != null ? `${formatNumber(model.residency.p50LatencyMs)} ms` : EM_DASH} />
            <Fact label="Loaded" value={model.residency ? formatRelativeTime(model.residency.loadedAt) : EM_DASH} />
            <Fact label="Last used" value={model.residency ? formatRelativeTime(model.residency.lastUsedAt) : EM_DASH} />
          </dl>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Keep policy</h3>
          <RadioGroup value={kind} onValueChange={(value) => setKind(value as ResidencyKeepPolicyKind)}>
            {KEEP_POLICY_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-start gap-2">
                <RadioGroupItem value={option.value} id={`keep-policy-${option.value}`} className="mt-0.5" />
                <Label htmlFor={`keep-policy-${option.value}`} className="flex flex-col gap-0.5 font-normal">
                  <span>{option.label}</span>
                  <span className="text-muted-foreground text-xs font-normal">{option.hint}</span>
                </Label>
              </div>
            ))}
          </RadioGroup>
          {kind !== 'always' ? (
            <div className="flex flex-col gap-1.5 pl-6">
              <Label htmlFor="keep-policy-idle-minutes">Idle minutes</Label>
              <Input
                id="keep-policy-idle-minutes"
                type="number"
                inputMode="numeric"
                min={0}
                value={idleMinutes}
                onChange={(event) => setIdleMinutes(event.target.value)}
                className="w-32"
              />
              <span className="text-muted-foreground text-xs">Blank inherits the service&rsquo;s own default.</span>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Currently: {model.keepPolicy.label} &mdash; {model.keepPolicy.reason}
          </p>
          <div>
            <Button size="sm" disabled={savePolicy.isPending} onClick={savePolicyDraft}>
              {savePolicy.isPending ? <Spinner /> : null}
              Save keep policy
            </Button>
          </div>
        </section>

        {isLmStudio ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Load options</h3>
            <p className="text-muted-foreground text-xs">
              Applied on the next Reload only &mdash; everything else about this deployment stays fixed at pod restart.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="residency-drawer-context">Context length</Label>
                <Input
                  id="residency-drawer-context"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={contextLength}
                  onChange={(event) => setContextLength(event.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="flex items-end gap-2 pb-1.5">
                <Checkbox id="residency-drawer-flash" checked={flashAttention} onCheckedChange={(checked) => setFlashAttention(checked === true)} />
                <Label htmlFor="residency-drawer-flash" className="font-normal">
                  Flash attention
                </Label>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </DetailDrawer>
  );
}

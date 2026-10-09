'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  ResidencyUseRole,
} from '../api/types';
import { residencyErrorMessage } from '@/shared/residency';
import { usePinResidencyModel, useResetResidencyPolicy, useSaveResidencyPolicy } from '../api/hooks';
import { modelResidencyKeys } from '../api/keys';
import {
  deviceShortLabel,
  drawerActions,
  formatModelStatus,
  formatStateWhere,
  humanizeTaskLabel,
  keepPolicyKindToClass,
  requiresUnloadReason,
} from './residency-display';

const EM_DASH = '—';

/** Every consumer role (TASK-1051 added the pipeline-stage and workflow-node kinds). */
const ROLE_LABEL: Record<ResidencyUseRole, string> = {
  primary: 'Primary',
  fallback: 'Fallback',
  routing: 'Routing policy',
  pipeline_stage: 'Pipeline stage',
  workflow_node: 'Workflow node',
};

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

/** "Couldn't pin Granite: lm-studio agent did not answer (SERVICE_UNREACHABLE)" — the server's words after what failed (AC-6). */
function failure(what: string, error: unknown): string {
  const reason = residencyErrorMessage(error, '');
  return reason ? `${what}: ${reason}` : `${what}.`;
}

/** The live load config's context length as the input's starting text ('' when the engine reported none). */
function liveContext(model: ResidencyCatalogueModel): string {
  const value = model.residency?.loadConfig?.contextLength;
  return value === null || value === undefined ? '' : String(value);
}

function liveFlash(model: ResidencyCatalogueModel): boolean {
  return model.residency?.loadConfig?.flashAttention === true;
}

function serverIdle(model: ResidencyCatalogueModel): string {
  return model.keepPolicy.idleTtlSeconds === null ? '' : String(Math.round(model.keepPolicy.idleTtlSeconds / 60));
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
  /** TASK-1051 — opens the link dialog for an unmatched running instance. */
  onLink: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
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
  onLink,
}: ModelDetailDrawerProps) {
  const savePolicy = useSaveResidencyPolicy();
  const resetPolicy = useResetResidencyPolicy();
  const pin = usePinResidencyModel();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ResidencyKeepPolicyKind>(model.keepPolicy.kind);
  const [idleMinutes, setIdleMinutes] = useState(serverIdle(model));
  // TASK-1055 (E10) — Reload options start from what the instance is ACTUALLY loaded with.
  const [contextLength, setContextLength] = useState(liveContext(model));
  const [flashAttention, setFlashAttention] = useState(liveFlash(model));
  const [flashTouched, setFlashTouched] = useState(false);
  const optionsSig = `${model.aiModelId}|${liveContext(model)}|${liveFlash(model)}`;
  const [optionsSeed, setOptionsSeed] = useState({ sig: optionsSig, context: liveContext(model), flash: liveFlash(model) });
  if (open && optionsSeed.sig !== optionsSig) {
    const edited = contextLength !== optionsSeed.context || flashTouched;
    setOptionsSeed({ sig: optionsSig, context: liveContext(model), flash: liveFlash(model) });
    if (!edited) {
      setContextLength(liveContext(model));
      setFlashAttention(liveFlash(model));
    }
  }

  // Re-seed the draft when a different model opens, or when the server's policy moved under an UNEDITED draft.
  const serverSig = `${model.aiModelId}|${model.keepPolicy.policyVersion}|${model.keepPolicy.kind}|${model.keepPolicy.idleTtlSeconds}`;
  const [seeded, setSeeded] = useState({ sig: serverSig, model: model.aiModelId, kind: model.keepPolicy.kind, idle: serverIdle(model) });
  if (open && seeded.sig !== serverSig) {
    const dirty = kind !== seeded.kind || idleMinutes !== seeded.idle;
    setSeeded({ sig: serverSig, model: model.aiModelId, kind: model.keepPolicy.kind, idle: serverIdle(model) });
    if (seeded.model !== model.aiModelId || !dirty) {
      setKind(model.keepPolicy.kind);
      setIdleMinutes(serverIdle(model));
    }
  }

  const idleInvalid = kind !== 'always' && idleMinutes.trim() !== '' && !/^\d+$/.test(idleMinutes.trim());

  function savePolicyDraft() {
    // The drawer is only opened for a model that has a catalogue entry
    // (`service-section.tsx` hides "Details" for an orphan resident model),
    // so this is a defensive guard, not an expected path.
    if (!model.aiModelId || idleInvalid) return;
    savePolicy.mutate(
      {
        aiModelId: model.aiModelId,
        service: service.service,
        policyId: model.keepPolicy.policyId,
        policyVersion: model.keepPolicy.policyVersion,
        class: keepPolicyKindToClass(kind),
        idleTtlSeconds: kind === 'always' || idleMinutes.trim() === '' ? null : Number(idleMinutes.trim()) * 60,
      },
      {
        onSuccess: () => toast.success(`Keep policy saved for ${model.name}.`),
        onError: (error) => {
          const status = (error as { status?: number } | null)?.status;
          if (status === 412 || status === 409) {
            toast.error('This policy changed since you opened it — reload to see the latest.', {
              action: {
                label: 'Reload',
                onClick: () => {
                  setKind(model.keepPolicy.kind);
                  setIdleMinutes(serverIdle(model));
                  void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.catalogue() });
                },
              },
            });
            return;
          }
          toast.error(failure(`Couldn't save the keep policy for ${model.name}`, error));
        },
      },
    );
  }

  /** TASK-1055 (E9) — delete the explicit row: back to the implicit live-path / on-demand default. */
  function resetPolicyToDefault() {
    const { policyId, policyVersion } = model.keepPolicy;
    if (!policyId || policyVersion === null) return;
    resetPolicy.mutate(
      { policyId, policyVersion },
      {
        onSuccess: () => toast.success(`${model.name} is back to its default keep policy.`),
        onError: (error) => {
          const status = (error as { status?: number } | null)?.status;
          if (status === 412) {
            toast.error('This policy changed since you opened it — reload to see the latest.');
            void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.catalogue() });
            return;
          }
          toast.error(failure(`Couldn't reset the keep policy for ${model.name}`, error));
        },
      },
    );
  }

  // Mirrors `service-section.tsx`: a service with no control API (e.g. stt-worker) never offers an
  // action here either, regardless of what `model.actions` says.
  const resident = model.kind === 'resident';
  const actions = drawerActions(service, model);
  const pinnedByPolicy = model.keepPolicy.kind === 'always';
  const unloadNeedsReason = requiresUnloadReason(model);
  const explicitPolicy = model.keepPolicy.source === 'policy' && model.keepPolicy.policyId !== null && model.keepPolicy.policyVersion !== null;
  const loadConfig = model.residency?.loadConfig ?? null;
  const canPin = service.controllable && resident && model.status === 'loaded';

  function togglePin() {
    const pinned = !pinnedByPolicy;
    pin.mutate(
      { service: service.service, modelRef: model.modelRef, pinned },
      {
        onSuccess: () => toast.success(pinned ? `${model.name} pinned on ${service.label}.` : `${model.name} unpinned.`),
        onError: (error) => toast.error(failure(`Couldn't ${pinned ? 'pin' : 'unpin'} ${model.name}`, error)),
      },
    );
  }
  const isLmStudio = service.service === 'lm-studio';

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={model.name}
      badges={
        <>
          <Badge variant="outline">{service.label}</Badge>
          {resident ? <Badge variant="secondary">{formatStateWhere(model, devices).state}</Badge> : null}
          {pinnedByPolicy ? <Badge variant="outline">{model.usage.liveConsultation ? 'Pinned · live path' : 'Pinned'}</Badge> : null}
        </>
      }
      meta={<span className="font-mono">{model.slug ?? model.modelRef}</span>}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {actions.includes('load') ? (
            <Button disabled={actionPending} onClick={() => onLoad(service, model)}>
              {actionPending ? <Spinner /> : null}
              Load
            </Button>
          ) : null}
          {actions.includes('unload') ? (
            <>
              {unloadNeedsReason ? (
                <span id="drawer-unload-why" className="text-muted-foreground mr-auto text-xs">
                  {model.keepPolicy.reason || 'On the live path'} — unloading it asks for a reason.
                </span>
              ) : null}
              <Button
                variant="destructive"
                disabled={actionPending}
                aria-describedby={unloadNeedsReason ? 'drawer-unload-why' : undefined}
                onClick={() => onUnload(service, model)}
              >
                {actionPending ? <Spinner /> : null}
                Unload
              </Button>
            </>
          ) : null}
          {actions.includes('reload') && isLmStudio ? (
            <Button
              disabled={actionPending}
              onClick={() =>
                onReload(service, model, {
                  ...(contextLength.trim() !== '' && contextLength !== optionsSeed.context ? { contextLength: Number(contextLength) } : {}),
                  ...(flashTouched && flashAttention !== optionsSeed.flash ? { flashAttention } : {}),
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
        {!resident ? (
          <p className="text-muted-foreground rounded-md border p-3 text-sm">
            Not applicable — {model.kind === 'remote' ? 'a remote (cloud) model' : 'a model built into a library'} holds no memory on a GPU, so there
            is nothing to load, unload or pin.
          </p>
        ) : null}

        {model.identity.matched === false ? (
          <section className="flex flex-col gap-2" aria-labelledby="drawer-identity-h">
            <h3 id="drawer-identity-h" className="text-sm font-medium">
              Runtime identity
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Catalogue key</dt>
              <dd className="font-mono">{model.slug ?? EM_DASH}</dd>
              <dt className="text-muted-foreground">{service.label} reports</dt>
              <dd className="font-mono break-all">{model.identity.reportedKey ?? EM_DASH}</dd>
            </dl>
            <p className="text-muted-foreground text-xs">
              Until you confirm the link, HOPE counts this model as not loaded and keeps recommending a second copy.
            </p>
            <div>
              <Button size="sm" variant="outline" onClick={() => onLink(service, model)}>
                Review and link…
              </Button>
            </div>
          </section>
        ) : null}

        {resident ? (
          <section className="flex flex-col gap-2" aria-labelledby="drawer-pinned-h">
            <h3 id="drawer-pinned-h" className="text-sm font-medium">
              {pinnedByPolicy ? 'Why it is pinned' : 'Who uses it'}
            </h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(
                [
                  ['Agents (primary)', model.usage.consumers.agents],
                  ['Workflow nodes', model.usage.consumers.workflowNodes],
                  ['Pipeline stages', model.usage.consumers.pipelineStages],
                  ['Routing policies', model.usage.consumers.routingPolicies],
                  ['Fallback chains', model.usage.consumers.fallbacks],
                ] as const
              ).map(([label, count]) => (
                <div key={label} className="flex flex-col-reverse rounded-md border p-2">
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{formatNumber(count)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground text-xs">
              {model.keepPolicy.label} &mdash; {model.keepPolicy.reason}
            </p>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Agents and tenants</h3>
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
                      <TableCell>{ROLE_LABEL[use.role]}</TableCell>
                      <TableCell>{use.liveConsultation ? <Badge variant="secondary">Live consultations</Badge> : EM_DASH}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {resident ? (
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
              <Fact
                label="Load budget"
                value={model.budgetBytes !== null ? formatBytes(model.budgetBytes) : 'No size known — a load needs a reason'}
              />
              <Fact label="Load time" value={model.loadSeconds !== null ? `${formatNumber(Math.round(model.loadSeconds))} s` : EM_DASH} />
              <Fact label="In flight" value={model.residency ? formatNumber(model.residency.inFlight) : EM_DASH} />
              <Fact
                label="Requests / min"
                value={model.residency?.requestsPerMin != null ? formatNumber(Math.round(model.residency.requestsPerMin * 10) / 10) : EM_DASH}
              />
              <Fact
                label="p50 latency"
                value={model.residency?.p50LatencyMs != null ? `${formatNumber(model.residency.p50LatencyMs)} ms` : EM_DASH}
              />
              <Fact label="Loaded" value={model.residency ? formatRelativeTime(model.residency.loadedAt) : EM_DASH} />
              <Fact label="Last used" value={model.residency ? formatRelativeTime(model.residency.lastUsedAt) : EM_DASH} />
            </dl>
            {canPin ? (
              <div>
                <Button size="sm" variant="outline" disabled={pin.isPending} onClick={togglePin}>
                  {pin.isPending ? <Spinner /> : null}
                  {pinnedByPolicy ? 'Unpin on running service' : 'Pin on running service'}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {resident ? (
          <section className="flex flex-col gap-2">
            <h3 id="drawer-keep-policy-h" className="text-sm font-medium">
              Keep policy
            </h3>
            <RadioGroup aria-labelledby="drawer-keep-policy-h" value={kind} onValueChange={(value) => setKind(value as ResidencyKeepPolicyKind)}>
              {KEEP_POLICY_OPTIONS.map((option) => (
                <div key={option.value} className="flex items-start gap-2">
                  <RadioGroupItem
                    value={option.value}
                    id={`keep-policy-${option.value}`}
                    className="mt-0.5"
                    disabled={option.value === 'on_demand' && model.usage.liveConsultation}
                  />
                  <Label htmlFor={`keep-policy-${option.value}`} className="flex flex-col gap-0.5 font-normal">
                    <span>{option.label}</span>
                    <span className="text-muted-foreground text-xs font-normal">
                      {option.value === 'on_demand' && model.usage.liveConsultation
                        ? 'Unavailable: a live-consultation path uses this model, so it must stay loaded.'
                        : option.hint}
                    </span>
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
                  aria-invalid={idleInvalid || undefined}
                  aria-describedby={idleInvalid ? 'keep-policy-idle-error' : undefined}
                  className="w-32"
                />
                {idleInvalid ? (
                  <span id="keep-policy-idle-error" className="text-destructive text-sm">
                    Enter whole minutes, 0 or more.
                  </span>
                ) : null}
                <span className="text-muted-foreground text-xs">Blank inherits the service&rsquo;s own default.</span>
              </div>
            ) : null}
            <p className="text-muted-foreground text-xs">
              Currently: {model.keepPolicy.label} &mdash; {model.keepPolicy.reason}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={savePolicy.isPending || resetPolicy.isPending || idleInvalid} onClick={savePolicyDraft}>
                {savePolicy.isPending ? <Spinner /> : null}
                Save keep policy
              </Button>
              {explicitPolicy ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={savePolicy.isPending || resetPolicy.isPending}
                  aria-describedby="keep-policy-reset-hint"
                  onClick={resetPolicyToDefault}
                >
                  {resetPolicy.isPending ? <Spinner /> : null}
                  Reset to default
                </Button>
              ) : null}
              {explicitPolicy ? (
                <span id="keep-policy-reset-hint" className="text-muted-foreground text-xs">
                  Removes this setting: always loaded when a live path uses it, loaded when needed otherwise.
                </span>
              ) : null}
            </div>
          </section>
        ) : null}

        {isLmStudio ? (
          <section className="flex flex-col gap-2" aria-labelledby="drawer-load-options-h">
            <h3 id="drawer-load-options-h" className="text-sm font-medium">
              Load options
            </h3>
            <p className="text-muted-foreground text-xs">
              Applied on the next Reload; anything you leave unchanged is restored from the model&rsquo;s serving profile.
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
                <Checkbox
                  id="residency-drawer-flash"
                  checked={flashAttention}
                  onCheckedChange={(checked) => {
                    setFlashTouched(true);
                    setFlashAttention(checked === true);
                  }}
                />
                <Label htmlFor="residency-drawer-flash" className="font-normal">
                  Flash attention
                </Label>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Fact label="Parallel slots" value={loadConfig?.parallel != null ? formatNumber(loadConfig.parallel) : EM_DASH} />
              <Fact
                label="KV cache"
                value={
                  loadConfig?.kvCacheQuantK || loadConfig?.kvCacheQuantV
                    ? `${loadConfig.kvCacheQuantK ?? EM_DASH} / ${loadConfig.kvCacheQuantV ?? EM_DASH}`
                    : EM_DASH
                }
              />
              <Fact label="Placement" value={deviceShortLabel(loadConfig?.device ?? model.residency?.device ?? null, devices) || EM_DASH} />
            </dl>
            <p className="text-muted-foreground text-xs">Parallel slots, KV cache and placement come from the model&rsquo;s serving profile.</p>
          </section>
        ) : null}
      </div>
    </DetailDrawer>
  );
}

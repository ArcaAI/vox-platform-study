import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Input, Label, Switch, Textarea } from '@arcaai/ui';
import { ConfirmDialog } from '../../components';
import type { HarnessPolicyResponse, UpdateHarnessPolicyRequest } from '../api/harness';
import { formatPercent } from '../lib/format';

/**
 * Safety-critical thresholds (TASK-330 Phase 6): LOWERING any of these — or
 * disabling a safety/PHI toggle — weakens the clinical guardrails, so it must be
 * explicitly confirmed before the OCC PATCH is sent.
 */
const SAFETY_THRESHOLDS = [
  { key: 'entityFaithfulnessThreshold', label: 'Entity faithfulness' },
  { key: 'numericDoseThreshold', label: 'Numeric / dose' },
  { key: 'citationPresenceThreshold', label: 'Citation presence' },
  { key: 'groundednessThreshold', label: 'Groundedness' },
] as const;

const THRESHOLD_FIELDS = [
  { key: 'entityFaithfulnessThreshold', label: 'Entity faithfulness', safety: true },
  { key: 'numericDoseThreshold', label: 'Numeric / dose', safety: true },
  { key: 'citationPresenceThreshold', label: 'Citation presence', safety: true },
  { key: 'groundednessThreshold', label: 'Groundedness', safety: true },
  { key: 'coverageThreshold', label: 'Coverage', safety: false },
] as const;

type ThresholdKey = (typeof THRESHOLD_FIELDS)[number]['key'];

interface Draft {
  entityFaithfulnessThreshold: string;
  numericDoseThreshold: string;
  citationPresenceThreshold: string;
  groundednessThreshold: string;
  coverageThreshold: string;
  safetyEnabled: boolean;
  phiEnabled: boolean;
  phiFailClosed: boolean;
  safetyProvider: string;
  safetyModel: string;
  smrProvider: string;
  smrModel: string;
  maxRegen: string;
  gateSlaSeconds: string;
  gateEscalationSeconds: string;
  toolAllowlist: string;
  reason: string;
}

function toDraft(policy: HarnessPolicyResponse): Draft {
  return {
    entityFaithfulnessThreshold: String(policy.entityFaithfulnessThreshold),
    numericDoseThreshold: String(policy.numericDoseThreshold),
    citationPresenceThreshold: String(policy.citationPresenceThreshold),
    groundednessThreshold: String(policy.groundednessThreshold),
    coverageThreshold: String(policy.coverageThreshold),
    safetyEnabled: policy.safetyEnabled,
    phiEnabled: policy.phiEnabled,
    phiFailClosed: policy.phiFailClosed,
    safetyProvider: policy.safetyProvider,
    safetyModel: policy.safetyModel,
    smrProvider: policy.smrProvider ?? '',
    smrModel: policy.smrModel ?? '',
    maxRegen: String(policy.maxRegen),
    gateSlaSeconds: String(policy.gateSlaSeconds),
    gateEscalationSeconds: String(policy.gateEscalationSeconds),
    toolAllowlist: (policy.toolAllowlist ?? []).join('\n'),
    reason: '',
  };
}

function parseAllowlist(text: string): string[] | null {
  const tools = text
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : null;
}

const SOURCE_LABEL: Record<HarnessPolicyResponse['source'], string> = {
  tenant: 'tenant override',
  'system-default': 'system default',
  'code-default': 'code default',
};

interface PolicyEditorProps {
  policy: HarnessPolicyResponse;
  isSaving: boolean;
  onSubmit: (body: UpdateHarnessPolicyRequest, version: number) => void;
  title: string;
  description: string;
  scopeBadge: string;
  idPrefix: string;
}

export function PolicyEditor({ policy, isSaving, onSubmit, title, description, scopeBadge, idPrefix }: PolicyEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(policy));
  const [error, setError] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState<string[] | null>(null);

  // Re-seed whenever the persisted policy changes (initial load + post-save).
  useEffect(() => {
    setDraft(toDraft(policy));
    setError(null);
  }, [policy.version, policy.id, policy.source]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // The sparse PATCH body: only fields that differ from the persisted policy.
  const { body, hasChanges } = useMemo(() => {
    const patch: UpdateHarnessPolicyRequest = {};

    for (const { key } of THRESHOLD_FIELDS) {
      const next = Number(draft[key]);
      if (Number.isFinite(next) && next !== policy[key]) patch[key] = next;
    }
    if (draft.safetyEnabled !== policy.safetyEnabled) patch.safetyEnabled = draft.safetyEnabled;
    if (draft.phiEnabled !== policy.phiEnabled) patch.phiEnabled = draft.phiEnabled;
    if (draft.phiFailClosed !== policy.phiFailClosed) patch.phiFailClosed = draft.phiFailClosed;
    if (draft.safetyProvider !== policy.safetyProvider) patch.safetyProvider = draft.safetyProvider;
    if (draft.safetyModel !== policy.safetyModel) patch.safetyModel = draft.safetyModel;

    const smrProvider = draft.smrProvider.trim() || null;
    if (smrProvider !== (policy.smrProvider ?? null)) patch.smrProvider = smrProvider;
    const smrModel = draft.smrModel.trim() || null;
    if (smrModel !== (policy.smrModel ?? null)) patch.smrModel = smrModel;

    const maxRegen = Number(draft.maxRegen);
    if (Number.isInteger(maxRegen) && maxRegen !== policy.maxRegen) patch.maxRegen = maxRegen;
    const gateSla = Number(draft.gateSlaSeconds);
    if (Number.isInteger(gateSla) && gateSla !== policy.gateSlaSeconds) patch.gateSlaSeconds = gateSla;
    const gateEsc = Number(draft.gateEscalationSeconds);
    if (Number.isInteger(gateEsc) && gateEsc !== policy.gateEscalationSeconds) patch.gateEscalationSeconds = gateEsc;

    const allowlist = parseAllowlist(draft.toolAllowlist);
    if (JSON.stringify(allowlist) !== JSON.stringify(policy.toolAllowlist ?? null)) patch.toolAllowlist = allowlist;

    const hasChanges = Object.keys(patch).length > 0;
    if (hasChanges && draft.reason.trim()) patch.reason = draft.reason.trim();
    return { body: patch, hasChanges };
  }, [draft, policy]);

  /** Human-readable list of safety-weakening edits that require confirmation. */
  const safetyWarnings = useMemo(() => {
    const warnings: string[] = [];
    for (const { key, label } of SAFETY_THRESHOLDS) {
      const next = Number(draft[key as ThresholdKey]);
      if (Number.isFinite(next) && next < policy[key]) {
        warnings.push(`Lower ${label} threshold ${formatPercent(policy[key])} → ${formatPercent(next)}`);
      }
    }
    if (policy.safetyEnabled && !draft.safetyEnabled) warnings.push('Disable the safety guardrail');
    if (policy.phiEnabled && !draft.phiEnabled) warnings.push('Disable PHI detection');
    if (policy.phiFailClosed && !draft.phiFailClosed) warnings.push('Disable PHI fail-closed');
    return warnings;
  }, [draft, policy]);

  const validate = (): boolean => {
    for (const { key, label } of THRESHOLD_FIELDS) {
      const value = Number(draft[key]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        setError(`${label} threshold must be a number between 0 and 1.`);
        return false;
      }
    }
    for (const [value, label] of [
      [draft.maxRegen, 'Max regen'],
      [draft.gateSlaSeconds, 'Gate SLA'],
      [draft.gateEscalationSeconds, 'Gate escalation'],
    ] as const) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        setError(`${label} must be a non-negative integer.`);
        return false;
      }
    }
    setError(null);
    return true;
  };

  const handleSave = () => {
    if (!validate() || !hasChanges) return;
    if (safetyWarnings.length > 0) {
      setConfirmWarnings(safetyWarnings);
      return;
    }
    onSubmit(body, policy.version);
  };

  const confirmSave = () => {
    setConfirmWarnings(null);
    onSubmit(body, policy.version);
  };

  return (
    <section className="rounded-md border p-4" aria-label={title} data-testid={`${idPrefix}-policy-editor`}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-lg font-semibold">{title}</h3>
        <Badge variant="secondary">{scopeBadge}</Badge>
        <Badge variant="outline" className="text-[10px] uppercase">
          {SOURCE_LABEL[policy.source]}
        </Badge>
      </div>
      <p className="text-muted-foreground mb-4 text-sm">{description}</p>

      {/* Sensor thresholds */}
      <h4 className="mb-2 text-sm font-medium">Sensor thresholds</h4>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {THRESHOLD_FIELDS.map(({ key, label, safety }) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`${idPrefix}-${key}`} className="flex items-center gap-1">
              {label}
              {safety && (
                <Badge variant="outline" className="text-[9px] uppercase text-amber-600 dark:text-amber-400">
                  safety
                </Badge>
              )}
            </Label>
            <Input
              id={`${idPrefix}-${key}`}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft[key]}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value)}
            />
            <p className="text-muted-foreground text-xs">{formatPercent(Number(draft[key]))}</p>
          </div>
        ))}
      </div>

      {/* Safety toggles */}
      <h4 className="mb-2 text-sm font-medium">Safety toggles</h4>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <ToggleRow
          id={`${idPrefix}-safetyEnabled`}
          label="Safety guardrail"
          hint="Master content-safety guard."
          checked={draft.safetyEnabled}
          onChange={(v) => set('safetyEnabled', v)}
        />
        <ToggleRow
          id={`${idPrefix}-phiEnabled`}
          label="PHI detection"
          hint="Detect protected health info."
          checked={draft.phiEnabled}
          onChange={(v) => set('phiEnabled', v)}
        />
        <ToggleRow
          id={`${idPrefix}-phiFailClosed`}
          label="PHI fail-closed"
          hint="Block on detector error."
          checked={draft.phiFailClosed}
          onChange={(v) => set('phiFailClosed', v)}
        />
      </div>

      {/* Models & providers */}
      <h4 className="mb-2 text-sm font-medium">Models &amp; providers</h4>
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Field
          id={`${idPrefix}-safetyProvider`}
          label="Safety provider"
          value={draft.safetyProvider}
          onChange={(v) => set('safetyProvider', v)}
          placeholder="e.g. lm-studio"
        />
        <Field
          id={`${idPrefix}-safetyModel`}
          label="Safety model"
          value={draft.safetyModel}
          onChange={(v) => set('safetyModel', v)}
          placeholder="e.g. granite-guardian-4.1-8b"
        />
        <Field
          id={`${idPrefix}-smrProvider`}
          label="SMR provider"
          value={draft.smrProvider}
          onChange={(v) => set('smrProvider', v)}
          placeholder="(blank = SMR service chooses)"
        />
        <Field
          id={`${idPrefix}-smrModel`}
          label="SMR model"
          value={draft.smrModel}
          onChange={(v) => set('smrModel', v)}
          placeholder="(blank = SMR service chooses)"
        />
      </div>

      {/* Loop budget & gate timers */}
      <h4 className="mb-2 text-sm font-medium">Loop budget &amp; gate timers</h4>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Field id={`${idPrefix}-maxRegen`} label="Max regen" type="number" value={draft.maxRegen} onChange={(v) => set('maxRegen', v)} />
        <Field
          id={`${idPrefix}-gateSlaSeconds`}
          label="Gate SLA (seconds)"
          type="number"
          value={draft.gateSlaSeconds}
          onChange={(v) => set('gateSlaSeconds', v)}
        />
        <Field
          id={`${idPrefix}-gateEscalationSeconds`}
          label="Gate escalation (seconds)"
          type="number"
          value={draft.gateEscalationSeconds}
          onChange={(v) => set('gateEscalationSeconds', v)}
        />
      </div>

      {/* Tool allowlist */}
      <div className="mb-4 space-y-1">
        <Label htmlFor={`${idPrefix}-toolAllowlist`}>Tool allowlist</Label>
        <Textarea
          id={`${idPrefix}-toolAllowlist`}
          value={draft.toolAllowlist}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set('toolAllowlist', e.target.value)}
          placeholder="One tool id per line — blank allows all tools"
          className="resize-none font-mono text-xs"
          rows={3}
        />
        <p className="text-muted-foreground text-xs">Leave blank to allow every tool. One tool id per line (commas also accepted).</p>
      </div>

      {/* Reason */}
      <div className="mb-4 space-y-1">
        <Label htmlFor={`${idPrefix}-reason`}>Change reason</Label>
        <Input
          id={`${idPrefix}-reason`}
          value={draft.reason}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('reason', e.target.value)}
          placeholder="Recorded on the WORM policy-change row"
        />
      </div>

      {error && (
        <p className="text-destructive mb-3 text-xs" role="status" aria-live="polite" data-testid={`${idPrefix}-policy-error`}>
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={!hasChanges || isSaving} onClick={() => setDraft(toDraft(policy))}>
          Reset
        </Button>
        <Button disabled={!hasChanges || isSaving} onClick={handleSave} data-testid={`${idPrefix}-policy-save`}>
          Save policy
        </Button>
      </div>

      <ConfirmDialog
        open={confirmWarnings !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmWarnings(null);
        }}
        title="Weaken clinical safety guardrails?"
        description={`This change reduces the harness safety guardrails:\n\n• ${(confirmWarnings ?? []).join('\n• ')}\n\nThe next workflow run picks this up live and the edit is WORM-audited. Continue?`}
        confirmLabel="Apply weaker policy"
        cancelLabel="Keep current"
        variant="destructive"
        isLoading={isSaving}
        onConfirm={confirmSave}
      />
    </section>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="pr-2">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    </div>
  );
}

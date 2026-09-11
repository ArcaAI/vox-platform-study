'use client';

/**
 * TASK-890 §3.7/§3.10 — the agent Model step: Provider `Select` (the tenant's enabled BYO
 * connections first, then exactly one "Hope provider") over `GET admin/ai-models/catalogue`,
 * then a Model `Select` scoped to the chosen provider. Replaces the wizard's two hardcoded
 * `CLOUD_PROVIDERS` / `ENGINE_PROVIDERS` sets and the registry read at `GET admin/ai-models`
 * (super-admin-only since TASK-890 L1 — a tenant admin 403s it; the catalogue route is the one
 * this feature is allowed to call).
 *
 * An unusable provider or model is shown GREYED with its machine reason, never hidden — a gap
 * you cannot see is a gap you cannot fix (§3.7's `usable` contract). Shared by the create wizard
 * and the edit-draft form so the two pickers cannot drift.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Badge, Field, FieldDescription, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@arcaai/ui';
import { useModelCatalogue, type CatalogueModel, type CatalogueProvider } from '@/shared/catalog';
import { formatDateTime } from '@/shared/format';
import { AGENT_TASK_MODEL_TASK_TYPE, type AgentTask } from '../api';

const READINESS_LABEL: Record<string, string> = {
  ready: 'Ready',
  loadable: 'Loadable',
  engine_down: 'Engine down',
  weights_missing: 'Weights missing',
  credential_missing: 'Needs a credential',
  unknown: 'Unknown readiness',
};

export function modelReadinessLabel(model: Pick<CatalogueModel, 'readiness'>): string {
  return READINESS_LABEL[model.readiness] ?? model.readiness;
}

/**
 * TASK-952 D-5 — the catalogue's `usable: false` machine reason codes
 * (`packages/applications/src/services/ai-model/aiModel.service.ts`), mapped to short,
 * actionable guidance for the Provider/Model selects. `no-enabled-connection` and
 * `credential-missing` both name the SAME two-step fix (enable the connection, add a
 * credential) — a caller who only did one step still reads the same actionable text,
 * which is exactly the gap the reported user fell into. An UNKNOWN code is never
 * swallowed: `reasonGuidance` falls through to the raw code so a new one is visible,
 * not hidden behind a generic "unavailable".
 */
const REASON_GUIDANCE: Record<string, string> = {
  'no-enabled-connection': 'enable it with a credential on AI Providers',
  'credential-missing': 'enable it with a credential on AI Providers',
  'weights-not-available': 'model weights are not available yet',
  'connection-resolver-unavailable': 'provider connections are unavailable right now',
  'platform-credential-not-entitled': 'not included in your plan — add your own credential',
};

export function reasonGuidance(reason: string): string {
  return REASON_GUIDANCE[reason] ?? reason;
}

/** The catalogue for one agent task — shared by the primary-model picker and the fallback list. */
export function useTaskModelCatalogue(task: AgentTask) {
  const query = useModelCatalogue({ taskType: AGENT_TASK_MODEL_TASK_TYPE[task] });
  const providers = useMemo(() => query.data?.providers ?? [], [query.data]);
  const models = useMemo(() => query.data?.models ?? [], [query.data]);
  return { ...query, providers, models };
}

function providerLabel(provider: CatalogueProvider): string {
  return `${provider.name}${provider.group === 'byo' ? ' (BYO)' : ''}${provider.usable ? '' : ` — ${reasonGuidance(provider.reason ?? 'unavailable')}`}`;
}

function modelLabel(model: CatalogueModel): string {
  const readiness = model.providerClass === 'cloud-byo' ? '' : ` · ${modelReadinessLabel(model)}`;
  const unusable = model.usable ? '' : ` — ${reasonGuidance(model.unusableReason ?? 'unavailable')}`;
  return `${model.name}${readiness}${unusable}`;
}

export interface ModelPickerProps {
  id?: string;
  label?: string;
  task: AgentTask;
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  errors?: string[];
}

export function ModelPicker({ id, label = 'Model', task, value, onChange, disabled, errors }: ModelPickerProps) {
  const catalogue = useTaskModelCatalogue(task);
  const { providers, models } = catalogue;
  const selected = models.find((model) => model.id === value) ?? null;
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const providerId = providerOverride ?? selected?.providerId ?? providers[0]?.id ?? '';
  const activeProvider = providers.find((provider) => provider.id === providerId) ?? null;
  const modelsForProvider = models.filter((model) => model.providerId === providerId);

  const fieldId = id ?? 'model-picker';
  const invalid = (errors?.length ?? 0) > 0 ? 'true' : undefined;

  if (catalogue.isPending) {
    return (
      <Field>
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </Field>
    );
  }

  if (catalogue.isError || providers.length === 0) {
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
        <FieldDescription>
          {catalogue.isError ? 'The model catalogue is unavailable.' : 'No provider can serve this task yet.'}{' '}
          <Link href="/ai-providers" className="inline-flex items-center gap-1 underline">
            Check AI Providers <IconExternalLink aria-hidden className="size-3" />
          </Link>
        </FieldDescription>
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${fieldId}-provider`}>Provider</FieldLabel>
        <Select
          value={providerId}
          onValueChange={(next) => {
            setProviderOverride(next);
            onChange('');
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${fieldId}-provider`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {providerLabel(provider)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeProvider && !activeProvider.usable ? (
          <FieldDescription>
            {activeProvider.reason ?? 'This provider cannot serve requests today.'}{' '}
            <Link href="/ai-providers" className="inline-flex items-center gap-1 underline">
              Why can&apos;t I use this? <IconExternalLink aria-hidden className="size-3" />
            </Link>
          </FieldDescription>
        ) : null}
      </Field>
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={fieldId} className="w-full">
            <SelectValue placeholder={modelsForProvider.length ? 'Choose a model' : 'No models under this provider'} />
          </SelectTrigger>
          <SelectContent>
            {modelsForProvider.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {modelLabel(model)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected ? (
          <FieldDescription className="flex flex-wrap items-center gap-2">
            <Badge variant={selected.usable ? 'secondary' : 'destructive'}>{modelReadinessLabel(selected)}</Badge>
            {selected.readinessCheckedAt ? <span className="text-xs">as of {formatDateTime(selected.readinessCheckedAt)}</span> : null}
          </FieldDescription>
        ) : null}
      </Field>
    </div>
  );
}

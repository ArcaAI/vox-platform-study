import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { AdminApiError } from '../api/admin-client';
import { useGuardrailProviders, type GuardrailProvider } from '../api/guardrail';
import { useUpdateMyTenantConfigs, useUpdateTenantConfigs, type TenantConfig, type UpdateTenantConfigItem } from '../api/tenants';

const PROVIDER_KEY = 'default-guardrail-provider';
const MODEL_KEY = 'default-guardrail-model';
const AZURE_DEPLOYMENT_KEY = 'guardrail-azure-deployment';

interface GuardrailConfigSectionProps {
  configs: TenantConfig[];
  isSuperAdmin: boolean;
  effectiveTenantIdentifier: string;
  onSaved?: () => void;
}

interface NormalizedModelOption {
  value: string;
  label: string;
}

function modelOptionsFor(provider: GuardrailProvider | undefined): NormalizedModelOption[] {
  return (provider?.models ?? [])
    .map((rawModel): NormalizedModelOption | null => {
      if (typeof rawModel === 'string') {
        const value = rawModel.trim();
        return value.length > 0 ? { value, label: value } : null;
      }
      if (rawModel && typeof rawModel === 'object') {
        const value = (rawModel.name ?? rawModel.id ?? '').trim();
        return value.length > 0 ? { value, label: value } : null;
      }
      return null;
    })
    .filter((item): item is NormalizedModelOption => item != null);
}

/**
 * TASK-338 — admin-configurable Guardrail engine section.
 *
 * A dedicated, friendlier editor for the Guardrail provider/model + Azure
 * deployment-name GlobalSettings (separate from the generic key/value config
 * editor on the page). Provider/model are LOCKED settings (GLOBAL_ADMIN only);
 * the Azure deployment name is non-secret and editable by tenant admins. The
 * Azure API key is NEVER stored here — it remains in env/Vault (TASK-302 Phase
 * 4D will unblock admin-set keys).
 *
 * Persistence reuses the existing tenant-config PATCH hooks; each changed row
 * is saved individually with its own optimistic-concurrency `If-Match` version,
 * mirroring the page's single-row save plumbing.
 */
export function GuardrailConfigSection({ configs, isSuperAdmin, effectiveTenantIdentifier, onSaved }: GuardrailConfigSectionProps) {
  const providerRow = useMemo(() => configs.find((c) => c.key === PROVIDER_KEY), [configs]);
  const modelRow = useMemo(() => configs.find((c) => c.key === MODEL_KEY), [configs]);
  const azureRow = useMemo(() => configs.find((c) => c.key === AZURE_DEPLOYMENT_KEY), [configs]);

  const { data: providers, isLoading: providersLoading } = useGuardrailProviders();
  const updateTenantConfigs = useUpdateTenantConfigs();
  const updateMyTenantConfigs = useUpdateMyTenantConfigs();

  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [azureDeployment, setAzureDeployment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed the draft whenever the underlying rows change (initial load + after
  // a successful save refetch). Keyed on the persisted values + versions.
  const originalProvider = String(providerRow?.value ?? '');
  const originalModel = String(modelRow?.value ?? '');
  const originalAzure = String(azureRow?.value ?? '');

  useEffect(() => {
    setProvider(originalProvider);
    setModel(originalModel);
    setAzureDeployment(originalAzure);
    setError(null);
    setSaved(false);
  }, [originalProvider, originalModel, originalAzure]);

  // Guardrail settings are not seeded/loaded — render nothing rather than an
  // empty card, keeping the page unchanged for tenants without them.
  if (!providerRow && !modelRow && !azureRow) {
    return null;
  }

  const selectedProvider = providers?.find((p) => p.name === provider);
  const models = modelOptionsFor(selectedProvider);

  const providerModelLocked = !isSuperAdmin;

  const isDirty = provider !== originalProvider || model !== originalModel || azureDeployment !== originalAzure;

  const buildChangedRows = (): UpdateTenantConfigItem[] => {
    const rows: UpdateTenantConfigItem[] = [];
    if (providerRow && provider !== originalProvider && typeof providerRow.version === 'number') {
      rows.push({ id: providerRow.id, value: provider, expectedVersion: providerRow.version });
    }
    if (modelRow && model !== originalModel && typeof modelRow.version === 'number') {
      rows.push({ id: modelRow.id, value: model, expectedVersion: modelRow.version });
    }
    if (azureRow && azureDeployment !== originalAzure && typeof azureRow.version === 'number') {
      rows.push({ id: azureRow.id, value: azureDeployment, expectedVersion: azureRow.version });
    }
    return rows;
  };

  const persistRow = async (row: UpdateTenantConfigItem) => {
    const ifMatch = `"${row.expectedVersion}"`;
    if (isSuperAdmin) {
      await updateTenantConfigs.mutateAsync({ identifier: effectiveTenantIdentifier, configs: [row], ifMatch });
    } else {
      await updateMyTenantConfigs.mutateAsync({ configs: [row], ifMatch });
    }
  };

  const handleSave = async () => {
    setError(null);
    setSaved(false);
    const rows = buildChangedRows();
    if (rows.length === 0) return;

    setSaving(true);
    try {
      // Save each changed row independently so each carries its own OCC
      // version (a single `If-Match` header cannot represent a multi-row batch
      // whose versions differ).
      for (const row of rows) {
        await persistRow(row);
      }
      setSaved(true);
      onSaved?.();
    } catch (err) {
      if (err instanceof AdminApiError) {
        setError(`Save failed (${err.status}): ${err.message}`);
      } else {
        setError('Save failed. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setProvider(originalProvider);
    setModel(originalModel);
    setAzureDeployment(originalAzure);
    setError(null);
    setSaved(false);
  };

  return (
    <section className="mb-4 rounded-md border p-4" aria-label="Guardrail engine configuration">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-lg font-semibold">Guardrail Engine</h3>
        <Badge variant="secondary">guardrail</Badge>
      </div>
      <p className="text-muted-foreground mb-4 text-sm">
        Configure the content-safety provider, model, and Azure deployment name. The Azure API key is not stored here — it stays in environment/Vault.
      </p>

      {providersLoading ? (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Label>Model</Label>
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select
              value={provider}
              disabled={providerModelLocked}
              onValueChange={(v: string) => {
                setProvider(v);
                const next = providers?.find((p) => p.name === v);
                setModel(next?.default_model ?? '');
              }}
            >
              <SelectTrigger aria-label="Guardrail provider">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {providers?.map((p) => (
                  <SelectItem key={p.name} value={p.name} disabled={!p.is_available}>
                    <span className="flex items-center gap-2">
                      {p.name}
                      {!p.is_available && (
                        <Badge variant="secondary" className="text-[10px]">
                          offline
                        </Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
                {(!providers || providers.length === 0) && provider.length > 0 && <SelectItem value={provider}>{provider}</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Model</Label>
            <Select value={model} disabled={providerModelLocked} onValueChange={setModel}>
              <SelectTrigger aria-label="Guardrail model">
                <SelectValue placeholder={selectedProvider?.default_model || 'Select model'} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m, index) => (
                  <SelectItem key={`${m.value}-${index}`} value={m.value}>
                    {m.label}
                    {m.value === selectedProvider?.default_model && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        default
                      </Badge>
                    )}
                  </SelectItem>
                ))}
                {models.length === 0 && model.length > 0 && <SelectItem value={model}>{model}</SelectItem>}
                {models.length === 0 && model.length === 0 && (
                  <SelectItem value="_none" disabled>
                    No models available
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {providerModelLocked && (
        <p className="text-muted-foreground mt-2 text-xs">Provider and model are locked — only GLOBAL_ADMIN users may change them.</p>
      )}

      <div className="mt-4 space-y-2">
        <Label htmlFor="guardrail-azure-deployment">Azure Deployment Name</Label>
        <Input
          id="guardrail-azure-deployment"
          value={azureDeployment}
          placeholder="e.g. my-guardian-deployment"
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAzureDeployment(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">Used only when the provider is azure-openai. Non-secret; the API key remains in env/Vault.</p>
      </div>

      {error && (
        <p className="text-destructive mt-3 text-xs" aria-live="polite" role="status">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="mt-3 text-xs text-green-600" aria-live="polite" role="status">
          Saved.
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" disabled={!isDirty || saving} onClick={handleReset}>
          Reset
        </Button>
        <Button disabled={!isDirty || saving} onClick={handleSave}>
          Save Guardrail Settings
        </Button>
      </div>
    </section>
  );
}

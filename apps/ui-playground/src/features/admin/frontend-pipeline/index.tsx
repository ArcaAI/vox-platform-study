import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTenantFrontendConfig, type FrontendPipelineConfigJson, type UpsertTenantFrontendConfigInput } from '@arcaai/vox';
import { Loader2, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';

import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';

import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';

/**
 * TASK-328 A6 — Frontend Pipeline admin page.
 *
 * Per-tenant FRONTEND audio-capture defaults (applied to every user in the
 * tenant): an ASR model, four feature switches, and a typed advanced
 * `configJson`. Data flows through the `@arcaai/vox` `useTenantFrontendConfig`
 * hook (Q3). Tenant scoping is server-side: a global admin targets the
 * selected tenant via `tenantId`; a tenant admin's CLS tenant wins.
 */

// A small, curated set of ASR model ids the frontend can default to. Free-form
// values are still accepted via the "Custom" path on the backend; the select
// keeps the common choices one click away.
const ASR_MODEL_OPTIONS = [
  { value: 'whisper-large-v3', label: 'Whisper Large v3' },
  { value: 'whisper-medium', label: 'Whisper Medium' },
  { value: 'whisper-small', label: 'Whisper Small' },
  { value: 'whisper-tiny', label: 'Whisper Tiny' },
] as const;

const NOISE_LEVELS = ['low', 'medium', 'high'] as const;

interface FormState {
  asrModel: string;
  noiseCancel: boolean;
  vad: boolean;
  voiceEnrollment: boolean;
  diarization: boolean;
  configJson: FrontendPipelineConfigJson;
}

const EMPTY_FORM: FormState = {
  asrModel: '',
  noiseCancel: false,
  vad: false,
  voiceEnrollment: false,
  diarization: false,
  configJson: {},
};

/** Coerce a possibly-empty numeric input into `number | undefined`. */
function toNum(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export default function FrontendPipelinePage() {
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const tenantKey = useAuthStore((s) => s.tenantKey);

  // Global admins target the selected tenant; tenant admins fall through to
  // their CLS tenant (undefined → server uses the request tenant).
  const tenantId = isSuperAdmin() ? tenantKey || undefined : undefined;

  const { config, isLoading, error, get, save } = useTenantFrontendConfig();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(() => {
    void get(tenantId)
      .catch(() => undefined)
      .finally(() => setLoadedOnce(true));
  }, [get, tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  // Hydrate the form from the loaded config (or reset to defaults when none).
  useEffect(() => {
    if (config) {
      setForm({
        asrModel: config.asrModel ?? '',
        noiseCancel: config.noiseCancel,
        vad: config.vad,
        voiceEnrollment: config.voiceEnrollment,
        diarization: config.diarization,
        configJson: config.configJson ?? {},
      });
    } else if (loadedOnce) {
      setForm(EMPTY_FORM);
    }
  }, [config, loadedOnce]);

  const patchConfigJson = useCallback((patch: Partial<FrontendPipelineConfigJson>) => {
    setForm((prev) => ({ ...prev, configJson: { ...prev.configJson, ...patch } }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const input: UpsertTenantFrontendConfigInput = {
        asrModel: form.asrModel || null,
        noiseCancel: form.noiseCancel,
        vad: form.vad,
        voiceEnrollment: form.voiceEnrollment,
        diarization: form.diarization,
        configJson: form.configJson,
        // OCC: on update we MUST echo the version we read; on first create the
        // row has no version yet, so omit it.
        ...(config ? { expectedVersion: config.version } : {}),
      };
      await save(input, tenantId);
      toast.success('Frontend pipeline config saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save frontend pipeline config');
    } finally {
      setSaving(false);
    }
  }, [form, config, save, tenantId]);

  return (
    <Main>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Frontend Pipeline</h2>
          <p className="text-muted-foreground mt-1">Per-tenant capture defaults applied to every user in this tenant.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading} aria-label="Reload config">
          <RefreshCw data-icon="inline-start" className={isLoading ? 'animate-spin' : undefined} />
          Reload
        </Button>
      </div>

      {isLoading && !loadedOnce ? (
        <FrontendPipelineSkeleton />
      ) : (
        <div className="flex flex-col gap-6" data-testid="frontend-pipeline-form">
          {!config && loadedOnce && (
            <div
              className="bg-muted/20 text-muted-foreground rounded-xl border border-dashed p-4 text-sm"
              data-testid="frontend-pipeline-empty"
            >
              No frontend pipeline config yet for this tenant. Adjust the defaults below and save to create one.
            </div>
          )}
          {error && loadedOnce && !config && (
            <div className="text-destructive text-sm" role="alert">
              Couldn't load the existing config — you can still set new defaults below.
            </div>
          )}

          {/* Capture defaults */}
          <Card>
            <CardHeader>
              <CardTitle>Capture defaults</CardTitle>
              <CardDescription>ASR model + feature switches every user inherits.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="flex max-w-sm flex-col gap-2">
                <Label htmlFor="asr-model">ASR model</Label>
                <Select value={form.asrModel} onValueChange={(v: string) => setForm((p) => ({ ...p, asrModel: v }))}>
                  <SelectTrigger id="asr-model" aria-label="ASR model">
                    <SelectValue placeholder="Use platform default" />
                  </SelectTrigger>
                  <SelectContent>
                    {ASR_MODEL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FeatureSwitch
                  id="noiseCancel"
                  label="Noise cancellation"
                  description="Suppress background noise before STT."
                  checked={form.noiseCancel}
                  onChange={(v) => setForm((p) => ({ ...p, noiseCancel: v }))}
                />
                <FeatureSwitch
                  id="vad"
                  label="Voice activity detection"
                  description="Gate audio on detected speech."
                  checked={form.vad}
                  onChange={(v) => setForm((p) => ({ ...p, vad: v }))}
                />
                <FeatureSwitch
                  id="voiceEnrollment"
                  label="Voice enrollment"
                  description="Allow per-user voice profiles."
                  checked={form.voiceEnrollment}
                  onChange={(v) => setForm((p) => ({ ...p, voiceEnrollment: v }))}
                />
                <FeatureSwitch
                  id="diarization"
                  label="Diarization"
                  description="Separate speakers in the transcript."
                  checked={form.diarization}
                  onChange={(v) => setForm((p) => ({ ...p, diarization: v }))}
                />
              </div>
            </CardContent>
          </Card>

          {/* Advanced typed config */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SlidersHorizontal className="size-4" />
                Advanced configuration
              </CardTitle>
              <CardDescription>Fine-grained tuning (typed). Leave blank to use client defaults.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="noiseCancelLevel">Noise-cancel level</Label>
                <Select
                  value={form.configJson.noiseCancelLevel ?? ''}
                  onValueChange={(v: string) => patchConfigJson({ noiseCancelLevel: v as FrontendPipelineConfigJson['noiseCancelLevel'] })}
                >
                  <SelectTrigger id="noiseCancelLevel" aria-label="Noise-cancel level">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    {NOISE_LEVELS.map((lvl) => (
                      <SelectItem key={lvl} value={lvl}>
                        {lvl}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <NumberField
                id="vadThreshold"
                label="VAD threshold (0–1)"
                value={form.configJson.vadThreshold}
                step="0.05"
                onChange={(n) => patchConfigJson({ vadThreshold: n })}
              />
              <NumberField
                id="vadMinSilenceMs"
                label="VAD min silence (ms)"
                value={form.configJson.vadMinSilenceMs}
                onChange={(n) => patchConfigJson({ vadMinSilenceMs: n })}
              />
              <NumberField
                id="diarizationMaxSpeakers"
                label="Diarization max speakers"
                value={form.configJson.diarizationMaxSpeakers}
                onChange={(n) => patchConfigJson({ diarizationMaxSpeakers: n })}
              />
              <NumberField
                id="sampleRate"
                label="Sample rate (Hz)"
                value={form.configJson.sampleRate}
                onChange={(n) => patchConfigJson({ sampleRate: n })}
              />
              <div className="flex flex-col gap-2">
                <Label htmlFor="language">Language (BCP-47)</Label>
                <Input
                  id="language"
                  placeholder="auto-detect"
                  value={form.configJson.language ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    patchConfigJson({ language: e.target.value.trim() === '' ? null : e.target.value })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving} data-testid="frontend-pipeline-save">
              {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
              Save defaults
            </Button>
          </div>
        </div>
      )}
    </Main>
  );
}

function FeatureSwitch({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number | undefined;
  step?: string;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(toNum(e.target.value))}
      />
    </div>
  );
}

function FrontendPipelineSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="frontend-pipeline-skeleton">
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

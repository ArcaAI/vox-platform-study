import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  useTenantFrontendConfig,
  type CaptureMode,
  type FrontendPipelineConfigJson,
  type TranscriptionMode,
  type UpsertTenantFrontendConfigInput,
} from '@arcaai/vox';
import { Building2, Loader2, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';

import { useAuthStore } from '@/store/auth-store';

/**
 * TASK-331 doc-03 — Frontend Pipeline tab of the consolidated Audio Pipelines
 * page.
 *
 * Per-tenant FRONTEND audio-capture defaults (applied to every user in the
 * tenant): an ASR model, four feature switches, and a typed advanced
 * `configJson`. Data flows through the `@arcaai/vox` `useTenantFrontendConfig`
 * hook.
 *
 * Finding #1 (Critical): the surface previously gated on `isSuperAdmin()` and
 * derived the target tenant from the deprecated `tenantKey` (never written by
 * the header ScopeSwitcher). It now gates on `isGlobalScope()` and targets the
 * store's `tenantId` — the single value the ScopeSwitcher maintains. A
 * global-scope admin with no tenant selected sees an explicit "Select a tenant"
 * prompt and fires NO request (avoids the 400 the service returns when a global
 * role omits `tenantId`). Tenant admins fall through to their CLS tenant
 * (`undefined` → the server uses the request tenant).
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

// TASK-356 Phase 4 — tenant-scoped transcription mode + audio capture mode.
const TRANSCRIPTION_MODE_OPTIONS: { value: TranscriptionMode; label: string }[] = [
  { value: 'BACKEND', label: 'Backend (server-side STT)' },
  { value: 'LOCAL', label: 'Local (browser-side STT)' },
];

// `''` is the sentinel for "no tenant override" — the legacy `captureRawAudio`
// column then governs per-surface capture (R-6 back-compat).
const CAPTURE_MODE_OPTIONS: { value: CaptureMode; label: string }[] = [
  { value: 'RAW_AND_PROCESSED', label: 'Raw + processed' },
  { value: 'RAW_ONLY', label: 'Raw only' },
  { value: 'PROCESSED_ONLY', label: 'Processed only' },
  { value: 'NONE', label: 'None' },
];

interface FormState {
  asrModel: string;
  noiseCancel: boolean;
  vad: boolean;
  voiceEnrollment: boolean;
  diarization: boolean;
  captureRawAudio: boolean;
  transcriptionMode: TranscriptionMode;
  transcriptionModeLocked: boolean;
  captureMode: CaptureMode | '';
  configJson: FrontendPipelineConfigJson;
}

const EMPTY_FORM: FormState = {
  asrModel: '',
  noiseCancel: false,
  vad: false,
  voiceEnrollment: false,
  diarization: false,
  captureRawAudio: false,
  transcriptionMode: 'BACKEND',
  transcriptionModeLocked: false,
  captureMode: '',
  configJson: {},
};

/** Coerce a possibly-empty numeric input into `number | undefined`. */
function toNum(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function FrontendPipelineTab() {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantName = useAuthStore((s) => s.tenantName);

  // For API calls a global-scope admin targets the header-selected tenant via
  // store `tenantId`; a tenant admin falls through to their CLS tenant
  // (`undefined`). A global-scope admin with no tenant selected must NOT fire a
  // request — the service rejects a global role without `tenantId` (400).
  const targetTenantId = isGlobalScope ? tenantId || undefined : undefined;
  const needsTenant = isGlobalScope && !tenantId;
  const tenantLabel = tenantName || (tenantId ? `${tenantId.slice(0, 8)}\u2026` : '');

  const { config, isLoading, error, get, save } = useTenantFrontendConfig();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(() => {
    if (needsTenant) return;
    void get(targetTenantId)
      .catch(() => undefined)
      .finally(() => setLoadedOnce(true));
  }, [get, targetTenantId, needsTenant]);

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
        captureRawAudio: config.captureRawAudio ?? false,
        transcriptionMode: config.transcriptionMode ?? 'BACKEND',
        transcriptionModeLocked: config.transcriptionModeLocked ?? false,
        captureMode: config.captureMode ?? '',
        configJson: config.configJson ?? {},
      });
    } else if (loadedOnce) {
      setForm(EMPTY_FORM);
    }
  }, [config, loadedOnce]);

  // TASK-332 — the "Capture raw audio (local)" toggle is only operable when the
  // server reports the locked platform capability is on. Fail closed (disabled)
  // until a config is loaded that confirms the capability.
  const platformRawCaptureCapable = config?.platformRawCaptureCapable === true;

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
        captureRawAudio: form.captureRawAudio,
        transcriptionMode: form.transcriptionMode,
        transcriptionModeLocked: form.transcriptionModeLocked,
        // `''` (no override) clears the tenant capture mode → legacy column applies.
        captureMode: form.captureMode === '' ? null : form.captureMode,
        configJson: form.configJson,
        // OCC: on update we MUST echo the version we read; on first create the
        // row has no version yet, so omit it.
        ...(config ? { expectedVersion: config.version } : {}),
      };
      await save(input, targetTenantId);
      toast.success('Frontend pipeline config saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save frontend pipeline config');
    } finally {
      setSaving(false);
    }
  }, [form, config, save, targetTenantId]);

  // Global scope with no tenant selected — explicit prompt, no request fired.
  if (needsTenant) {
    return (
      <div
        className="bg-muted/20 text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm"
        data-testid="frontend-pipeline-select-tenant"
      >
        <Building2 className="size-8 opacity-60" />
        <p className="text-foreground text-sm font-medium">Select a tenant</p>
        <p>Pick a tenant from the switcher in the header to manage its frontend capture defaults.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Editing tenant:</span>
          <Badge variant="outline" className="gap-1.5" data-testid="frontend-pipeline-tenant">
            <Building2 className="size-3.5" />
            {tenantLabel || 'Current tenant'}
          </Badge>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading} aria-label="Reload config">
          <RefreshCw data-icon="inline-start" className={isLoading ? 'animate-spin' : undefined} />
          Reload
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">Per-tenant capture defaults applied to every user in this tenant.</p>

      {isLoading && !loadedOnce ? (
        <FrontendPipelineSkeleton />
      ) : (
        <div className="flex flex-col gap-6" data-testid="frontend-pipeline-form">
          {!config && loadedOnce && (
            <div className="bg-muted/20 text-muted-foreground rounded-xl border border-dashed p-4 text-sm" data-testid="frontend-pipeline-empty">
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
                <FeatureSwitch
                  id="captureRawAudio"
                  label="Capture raw audio (local)"
                  description="Save the raw microphone stream as a downloadable recording when the local pipeline is active."
                  checked={form.captureRawAudio}
                  onChange={(v) => setForm((p) => ({ ...p, captureRawAudio: v }))}
                  disabled={!platformRawCaptureCapable}
                  hint={
                    !platformRawCaptureCapable
                      ? 'Unavailable — the platform capability “enable-local-raw-capture” is turned off for this deployment.'
                      : undefined
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* TASK-356 — Transcription & capture mode */}
          <Card>
            <CardHeader>
              <CardTitle>Transcription &amp; capture mode</CardTitle>
              <CardDescription>
                Tenant default for where speech-to-text runs and which audio streams are captured.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="transcriptionMode">Transcription mode</Label>
                  <Select
                    value={form.transcriptionMode}
                    onValueChange={(v: string) => setForm((p) => ({ ...p, transcriptionMode: v as TranscriptionMode }))}
                  >
                    <SelectTrigger id="transcriptionMode" aria-label="Transcription mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSCRIPTION_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    Unless locked, a doctor&apos;s workflow preference can still override this.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="captureMode">Audio capture mode</Label>
                  <Select
                    value={form.captureMode === '' ? '__none__' : form.captureMode}
                    onValueChange={(v: string) =>
                      setForm((p) => ({ ...p, captureMode: v === '__none__' ? '' : (v as CaptureMode) }))
                    }
                  >
                    <SelectTrigger id="captureMode" aria-label="Audio capture mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No override (use capture toggle)</SelectItem>
                      {CAPTURE_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    Overrides the &ldquo;Capture raw audio&rdquo; toggle above when set.
                  </p>
                </div>
              </div>

              <FeatureSwitch
                id="transcriptionModeLocked"
                label="Lock transcription mode (doctors cannot override)"
                description="When on, every doctor in this tenant uses the mode above regardless of their workflow preference."
                checked={form.transcriptionModeLocked}
                onChange={(v) => setForm((p) => ({ ...p, transcriptionModeLocked: v }))}
              />
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
    </div>
  );
}

function FeatureSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{description}</p>
        {hint ? (
          <p className="text-muted-foreground mt-1 text-xs italic" data-testid={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
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

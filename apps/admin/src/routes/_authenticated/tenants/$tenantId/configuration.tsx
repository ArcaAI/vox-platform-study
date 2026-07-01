import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { useTenantFrontendConfig, type TenantFrontendConfig, type TranscriptionMode } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { Lock, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { reduceOccConflict } from '@/features/common/occ';
import { isSuperAdmin, isSystemTenant } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { formatDateTime, isAdminRole } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/configuration')({
    component: TenantConfigurationPage,
});

interface ConfigForm {
    noiseCancel: boolean;
    vad: boolean;
    diarization: boolean;
    voiceEnrollment: boolean;
    captureRawAudio: boolean;
    asrModel: string;
    language: string;
    transcriptionMode: TranscriptionMode;
    transcriptionModeLocked: boolean;
}

type BoolFlagKey = 'noiseCancel' | 'vad' | 'diarization' | 'voiceEnrollment';

const FLAGS: { key: BoolFlagKey; label: string; desc: string }[] = [
    { key: 'noiseCancel', label: 'Noise cancellation', desc: 'Suppress background noise during capture.' },
    { key: 'vad', label: 'Voice activity detection (VAD)', desc: 'Auto-segment speech and trim leading/trailing silence.' },
    { key: 'diarization', label: 'Speaker diarization', desc: 'Label who-spoke-when in transcripts.' },
    { key: 'voiceEnrollment', label: 'Voice enrollment', desc: 'Enroll clinician voiceprints for speaker identification.' },
];

const ASR_MODELS = ['whisper-large-v3', 'whisper-medium', 'whisper-small'];
const LANGUAGES = [
    { value: '', label: 'Auto-detect' },
    { value: 'en-US', label: 'English (US)' },
    { value: 'vi-VN', label: 'Vietnamese' },
    { value: 'es-ES', label: 'Spanish' },
];

function toForm(config: TenantFrontendConfig | null): ConfigForm {
    return {
        noiseCancel: config?.noiseCancel ?? false,
        vad: config?.vad ?? false,
        diarization: config?.diarization ?? false,
        voiceEnrollment: config?.voiceEnrollment ?? false,
        captureRawAudio: config?.captureRawAudio ?? false,
        asrModel: config?.asrModel ?? '',
        language: config?.configJson?.language ?? '',
        transcriptionMode: config?.transcriptionMode ?? 'BACKEND',
        transcriptionModeLocked: config?.transcriptionModeLocked ?? false,
    };
}

function TenantConfigurationPage() {
    const { tenantId } = Route.useParams();
    const tenant = useTenantDetailStore((s) => s.tenant);
    const roles = useAuthStore((s) => s.user?.roles);
    const superAdmin = isSuperAdmin(roles);
    const system = isSystemTenant(tenant);
    const canEdit = !system && isAdminRole(roles ?? undefined);

    const { get, save } = useTenantFrontendConfig();

    const [config, setConfig] = useState<TenantFrontendConfig | null>(null);
    const [form, setForm] = useState<ConfigForm>(toForm(null));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    const load = () => {
        setLoading(true);
        setError(null);
        get(superAdmin ? tenantId : undefined)
            .then((c) => {
                setConfig(c);
                setForm(toForm(c));
            })
            .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    const baseline = useMemo(() => toForm(config), [config]);
    const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline]);
    const rawCaptureCapable = config?.platformRawCaptureCapable ?? false;
    const disabled = !canEdit || isSaving;

    const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const saved = await save(
                {
                    noiseCancel: form.noiseCancel,
                    vad: form.vad,
                    diarization: form.diarization,
                    voiceEnrollment: form.voiceEnrollment,
                    captureRawAudio: form.captureRawAudio,
                    asrModel: form.asrModel || null,
                    transcriptionMode: form.transcriptionMode,
                    transcriptionModeLocked: form.transcriptionModeLocked,
                    configJson: { ...config?.configJson, language: form.language || null },
                    // OCC: echo the read version; omit on first-time create.
                    ...(config ? { expectedVersion: config.version } : {}),
                },
                superAdmin ? tenantId : undefined,
            );
            setConfig(saved);
            setForm(toForm(saved));
            toast.success('Configuration saved');
        } catch (err) {
            const occ = reduceOccConflict(err);
            if (occ.conflict) {
                toast.error(occ.message);
                load(); // refetch the latest so the user can re-apply on top
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
            }
        } finally {
            setIsSaving(false);
        }
    };

    if (loading && !config) {
        return (
            <div className="space-y-4">
                <Skeleton className="h-64 w-full" />
                <Skeleton className="h-40 w-full" />
            </div>
        );
    }

    if (error) {
        return (
            <Card className="flex flex-col items-center gap-3 p-10 text-center">
                <TriangleAlert className="size-8 text-destructive" />
                <p className="font-medium">Couldn’t load configuration</p>
                <p className="text-sm text-muted-foreground">{error.message}</p>
                <Button variant="outline" onClick={load}>
                    Retry
                </Button>
            </Card>
        );
    }

    return (
        <div className="space-y-5">
            {system ? (
                <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-sm">
                    <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                    <p className="text-muted-foreground">
                        The <span className="font-medium text-foreground">system tenant</span> configuration is locked and cannot be edited.
                    </p>
                </div>
            ) : null}

            <Card className="p-5">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">General</h2>
                <div className="mt-3 divide-y">
                    {FLAGS.map((flag) => (
                        <div key={flag.key} className="flex items-center justify-between gap-4 py-3.5">
                            <div className="min-w-0">
                                <Label htmlFor={`flag-${flag.key}`} className="font-medium">
                                    {flag.label}
                                </Label>
                                <p className="text-sm text-muted-foreground">{flag.desc}</p>
                            </div>
                            <Switch id={`flag-${flag.key}`} checked={form[flag.key]} onCheckedChange={(v) => set(flag.key, v)} disabled={disabled} />
                        </div>
                    ))}
                    <div className="flex items-center justify-between gap-4 py-3.5">
                        <div className="min-w-0">
                            <Label htmlFor="flag-captureRawAudio" className="font-medium">
                                Raw audio capture
                            </Label>
                            <p className="text-sm text-muted-foreground">
                                Retain the raw local audio stream.
                                {!rawCaptureCapable ? ' Disabled — the platform capability is turned off.' : ''}
                            </p>
                        </div>
                        <Switch
                            id="flag-captureRawAudio"
                            checked={form.captureRawAudio}
                            onCheckedChange={(v) => set('captureRawAudio', v)}
                            disabled={disabled || !rawCaptureCapable}
                        />
                    </div>
                </div>
            </Card>

            <Card className="p-5">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Speech-to-text (ASR)</h2>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="asr-model">ASR model</Label>
                        <Select value={form.asrModel || '__default__'} onValueChange={(v) => set('asrModel', v === '__default__' ? '' : v)} disabled={disabled}>
                            <SelectTrigger id="asr-model">
                                <SelectValue placeholder="Platform default" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__default__">Platform default</SelectItem>
                                {ASR_MODELS.map((m) => (
                                    <SelectItem key={m} value={m}>
                                        {m}
                                    </SelectItem>
                                ))}
                                {form.asrModel && !ASR_MODELS.includes(form.asrModel) ? <SelectItem value={form.asrModel}>{form.asrModel}</SelectItem> : null}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="asr-language">Default language</Label>
                        <Select value={form.language || '__auto__'} onValueChange={(v) => set('language', v === '__auto__' ? '' : v)} disabled={disabled}>
                            <SelectTrigger id="asr-language">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LANGUAGES.map((l) => (
                                    <SelectItem key={l.value || '__auto__'} value={l.value || '__auto__'}>
                                        {l.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="asr-mode">Transcription mode</Label>
                        <Select value={form.transcriptionMode} onValueChange={(v) => set('transcriptionMode', v as TranscriptionMode)} disabled={disabled}>
                            <SelectTrigger id="asr-mode">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="BACKEND">Backend (server)</SelectItem>
                                <SelectItem value="LOCAL">Local (on-device)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex items-center justify-between gap-4 self-end rounded-md border border-input px-3 py-2">
                        <Label htmlFor="asr-mode-lock" className="text-sm font-normal text-muted-foreground">
                            Lock mode for clinicians
                        </Label>
                        <Switch
                            id="asr-mode-lock"
                            checked={form.transcriptionModeLocked}
                            onCheckedChange={(v) => set('transcriptionModeLocked', v)}
                            disabled={disabled}
                        />
                    </div>
                </div>
            </Card>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                    {config ? `Last saved ${formatDateTime(config.updatedAt)} · ` : ''}all changes are audit-logged.
                </p>
                {canEdit ? (
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setForm(baseline)} disabled={!dirty || isSaving}>
                            Discard
                        </Button>
                        <Button onClick={() => void handleSave()} disabled={!dirty || isSaving}>
                            {isSaving ? 'Saving…' : 'Save changes'}
                        </Button>
                    </div>
                ) : null}
            </div>

            {superAdmin && tenant && !system ? (
                <ActingOnBanner
                    tenantName={tenant.name}
                    description="Changes apply immediately across all departments. A tenant-admin can edit only within their own tenant; OCC guards concurrent edits."
                />
            ) : null}
        </div>
    );
}

import { PlaygroundLayout } from '@/components/layout/playground-layout';
import { ImpersonationGuard } from '@/features/summarization/components/impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import { useAudioStore } from '@/store/audio-store';
import { useAuthStore } from '@/store/auth-store';
import { useArcaConfig, useAuth } from '@arcaai/vox';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { AudioImpersonationBanner, AudioPageHeaderAction } from './components/audio-page-chrome';
import { AudioWorkspace } from './components/audio-workspace';

export default function AudioPage() {
  const { isImpersonating, impersonatedUser } = useAuth();
  const localUser = useAuthStore((s: { user: { username?: string } | null }) => s.user);
  const { reset, applyTenantDefaults, applyResolvedConfig, setConfigReady, applyPersistedSelection } = useAudioStore();
  const tenantId = useAuthStore((s) => s.tenantId);
  const { requiresImpersonation, roles } = useDoctorContext();

  const tenantConfigSignatureRef = useRef<string | null>(null);
  const sdkReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  let arcaConfig: ReturnType<typeof useArcaConfig> | null = null;
  try {
    arcaConfig = useArcaConfig();
  } catch {
    /* SDK not ready */
  }

  const resolvedConfig = arcaConfig?.resolvedConfig ?? null;
  const configReady = arcaConfig?.configReady ?? false;
  const tenantConfig = arcaConfig?.tenantConfig ?? null;
  // TASK-329 P3 — the user's persisted local model + Whisper task live in the
  // SDK model registry (tenant/user-namespaced localStorage). Read them here so
  // we can layer the USER choice over the tenant/default already seeded below.
  const persistedModelId = arcaConfig?.models?.selected?.stt ?? null;
  const persistedSttTask = arcaConfig?.models?.selected?.sttTask ?? null;

  useEffect(() => {
    // Prefer SDK resolvedConfig when available and ready (TASK-244)
    if (resolvedConfig && configReady) {
      if (sdkReadyTimeoutRef.current) {
        clearTimeout(sdkReadyTimeoutRef.current);
        sdkReadyTimeoutRef.current = null;
      }
      const nextSignature = JSON.stringify(resolvedConfig);
      if (tenantConfigSignatureRef.current === nextSignature) return;
      tenantConfigSignatureRef.current = nextSignature;
      applyResolvedConfig(resolvedConfig);
      return;
    }

    // Fallback: SDK not available or not ready — use tenantConfig or timeout
    if (!tenantConfig) {
      sdkReadyTimeoutRef.current = setTimeout(() => {
        setConfigReady(true);
      }, 2000);
      return () => {
        if (sdkReadyTimeoutRef.current) clearTimeout(sdkReadyTimeoutRef.current);
      };
    }

    if (sdkReadyTimeoutRef.current) {
      clearTimeout(sdkReadyTimeoutRef.current);
      sdkReadyTimeoutRef.current = null;
    }

    const nextSignature = JSON.stringify({
      defaultLanguage: tenantConfig.defaultLanguage ?? null,
      defaultSttModel: tenantConfig.defaultSttModel ?? null,
      vadSensitivity: tenantConfig.vadSensitivity ?? null,
      codeSwitching: tenantConfig.features?.codeSwitching ?? null,
      localAsrModelIds: (tenantConfig.localAsrModels ?? []).map((model: { id: string }) => model.id).sort(),
    });

    if (tenantConfigSignatureRef.current === nextSignature) return;
    tenantConfigSignatureRef.current = nextSignature;

    applyTenantDefaults({
      defaultLanguage: tenantConfig.defaultLanguage ?? undefined,
      defaultSttModel: tenantConfig.defaultSttModel ?? undefined,
      vadSensitivity: tenantConfig.vadSensitivity ?? undefined,
      codeSwitching: tenantConfig.features?.codeSwitching,
      localAsrModels: tenantConfig.localAsrModels ? [...tenantConfig.localAsrModels].sort((a, b) => a.id.localeCompare(b.id)) : undefined,
    });
  }, [resolvedConfig, configReady, tenantConfig, applyTenantDefaults, applyResolvedConfig, setConfigReady]);

  // TASK-329 P3 — once the tenant/default config has seeded the store (above),
  // layer the USER's persisted model + task on top (USER → TENANT → DEFAULT).
  // Runs after the config effect in the same flush, so `availableAsrModels` is
  // already populated when `applyPersistedSelection` validates the user model.
  useEffect(() => {
    if (!configReady) return;
    applyPersistedSelection({ userModelId: persistedModelId, userTask: persistedSttTask });
  }, [configReady, persistedModelId, persistedSttTask, applyPersistedSelection]);

  const activeUser = isImpersonating ? impersonatedUser : localUser;

  const handleReset = () => {
    tenantConfigSignatureRef.current = null;
    reset();
    toast.success('Audio configuration reset to defaults');
  };

  return (
    <PlaygroundLayout
      title="Live Transcription"
      description="Select microphone sources, configure local or remote processing, and view real-time transcription."
      showServiceStatus={false}
      headerAction={
        <AudioPageHeaderAction
          isImpersonating={isImpersonating}
          impersonatedUsername={impersonatedUser?.username}
          activeUsername={activeUser?.username}
          onReset={handleReset}
        />
      }
    >
      <AudioImpersonationBanner
        isImpersonating={isImpersonating}
        impersonatedUsername={impersonatedUser?.username}
        description="Audio settings and recordings will be associated with the impersonated user."
      />

      {!tenantId ? (
        <div className="flex h-60 flex-col items-center justify-center text-center">
          <p className="text-muted-foreground text-sm">Tenant configuration required</p>
          <p className="text-muted-foreground mt-1 text-xs">Please log in with a valid tenant to access live transcription.</p>
        </div>
      ) : requiresImpersonation ? (
        <ImpersonationGuard
          roles={roles}
          featureName="live transcription"
          featureDescription="Live transcription requires pipeline access. As an admin, you need to impersonate a doctor user to load pipelines and start transcription sessions."
        />
      ) : (
        <AudioWorkspace />
      )}
    </PlaygroundLayout>
  );
}

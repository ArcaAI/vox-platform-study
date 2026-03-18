import { PlaygroundLayout } from '@/components/layout/playground-layout';
import { AudioWorkspace } from './components/audio-workspace';
import { useAuth, useArcaConfig } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';
import { useAudioStore } from '@/store/audio-store';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
    AudioImpersonationBanner,
    AudioPageHeaderAction,
} from './components/audio-page-chrome';

export default function AudioPage() {
    const { isImpersonating, impersonatedUser } = useAuth();
    const localUser = useAuthStore((s: { user: { username?: string } | null }) => s.user);
    const { reset, applyTenantDefaults, applyResolvedConfig, setConfigReady } = useAudioStore();

    const tenantConfigSignatureRef = useRef<string | null>(null);
    const sdkReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    let arcaConfig: ReturnType<typeof useArcaConfig> | null = null;
    try {
        arcaConfig = useArcaConfig();
    } catch { /* SDK not ready */ }

    const resolvedConfig = arcaConfig?.resolvedConfig ?? null;
    const configReady = arcaConfig?.configReady ?? false;
    const tenantConfig = arcaConfig?.tenantConfig ?? null;

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
            localAsrModelIds: (tenantConfig.localAsrModels ?? [])
                .map((model: { id: string }) => model.id)
                .sort(),
        });

        if (tenantConfigSignatureRef.current === nextSignature) return;
        tenantConfigSignatureRef.current = nextSignature;

        applyTenantDefaults({
            defaultLanguage: tenantConfig.defaultLanguage ?? undefined,
            defaultSttModel: tenantConfig.defaultSttModel ?? undefined,
            vadSensitivity: tenantConfig.vadSensitivity ?? undefined,
            codeSwitching: tenantConfig.features?.codeSwitching,
            localAsrModels: tenantConfig.localAsrModels
                ? [...tenantConfig.localAsrModels].sort((a, b) => a.id.localeCompare(b.id))
                : undefined,
        });
    }, [resolvedConfig, configReady, tenantConfig, applyTenantDefaults, applyResolvedConfig, setConfigReady]);

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

            <AudioWorkspace />
        </PlaygroundLayout>
    );
}

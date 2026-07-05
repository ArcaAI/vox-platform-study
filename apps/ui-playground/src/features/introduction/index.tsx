import { Callout } from '@/components/callout';
import { DocsLayout, type TocSection } from '@/components/layout/docs-layout';
import { useMyTenantConfigs, useUpdateMyTenantConfigs, type UpdateTenantConfigItem } from '@/features/admin/api/tenants';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useArcaConfig } from '@arcaai/vox';
import { Link } from '@tanstack/react-router';
import { Building2, Check, Settings2, Shield, X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { ServiceStatusGrid } from './components/service-status-grid';
import { TenantSettingsPanel } from './components/tenant-settings-panel';

const TENANT_ADMIN_ROLES = ['TENANT_ADMIN'] as const;

export default function Introduction() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantName = useAuthStore((s) => s.tenantName);
  const tenantKey = useAuthStore((s) => s.tenantKey);
  const user = useAuthStore((s) => s.user);

  const isSuperAdmin = useMemo(() => user?.roles?.includes('GLOBAL_ADMIN') ?? false, [user?.roles]);
  const isTenantAdmin = useMemo(
    () => isSuperAdmin || (user?.roles?.some((r) => TENANT_ADMIN_ROLES.includes(r as (typeof TENANT_ADMIN_ROLES)[number])) ?? false),
    [user?.roles, isSuperAdmin],
  );

  let tenantConfig: ReturnType<typeof useArcaConfig>['tenantConfig'] = null;
  try {
    const config = useArcaConfig();
    tenantConfig = config.tenantConfig;
  } catch {
    /* SDK not ready */
  }

  const { data: rawConfigsResponse } = useMyTenantConfigs({
    enabled: isTenantAdmin,
  });
  const rawConfigs = rawConfigsResponse?.data;

  const updateMutation = useUpdateMyTenantConfigs();
  const handleSaveConfigs = useCallback(
    (changes: UpdateTenantConfigItem[]) => {
      updateMutation.mutate({ configs: changes });
    },
    [updateMutation],
  );

  const sections: TocSection[] = useMemo(() => {
    const base: TocSection[] = [
      { id: 'what-is-arcavox', title: 'What is ArcaVox?' },
      { id: 'core-capabilities', title: 'Core Capabilities' },
      { id: 'packages', title: 'Packages' },
      { id: 'service-status', title: 'Service Status' },
    ];
    if (isTenantAdmin) {
      base.push({ id: 'tenant-settings', title: 'Tenant Settings' });
    }
    return base;
  }, [isTenantAdmin]);

  return (
    <DocsLayout
      title="Introduction"
      description="ArcaVox SDK — a React SDK for AI-powered medical consultation workflows."
      sections={sections}
      cta={{
        title: 'Get Started',
        description: 'Install the SDK and start building.',
        buttonLabel: 'Installation Guide',
        href: '/installation',
      }}
    >
      <Callout className="border-blue-600/30 bg-blue-50 dark:border-blue-400/30 dark:bg-blue-950/40">
        <p>
          <strong>Welcome to the ArcaVox Admin Console.</strong> Explore the SDK interactively. Head to{' '}
          <Link to="/installation" className="font-medium underline underline-offset-4">
            Installation
          </Link>{' '}
          to get started, or try the{' '}
          <Link to="/audio/live-transcription" className="font-medium underline underline-offset-4">
            Audio Playground
          </Link>{' '}
          to test real-time transcription.
        </p>
      </Callout>

      <section id="what-is-arcavox">
        <h2 className="text-xl font-semibold tracking-tight">What is ArcaVox?</h2>
        <p className="text-muted-foreground mt-2 leading-7">
          ArcaVox (<code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">@arcaai/vox</code>) is a React SDK for building healthcare
          consultation applications. It provides session management, a full audio pipeline (noise cancellation, voice activity detection,
          speech-to-text), context management, and AI-powered summary generation — all through a simple hooks-based API.
        </p>
      </section>

      <section id="core-capabilities">
        <h2 className="text-xl font-semibold tracking-tight">Core Capabilities</h2>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <h3 className="font-medium">Session Management</h3>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              Open and close consultation sessions, manage patient context, and track consultation lifecycle.
            </p>
          </div>
          <Separator />
          <div>
            <h3 className="font-medium">Audio Pipeline</h3>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              Microphone input → RNNoise noise cancellation → Silero VAD voice detection → Whisper speech-to-text. Runs entirely in the browser via
              WebAssembly and WebGPU.
            </p>
          </div>
          <Separator />
          <div>
            <h3 className="font-medium">Context & Summaries</h3>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              Manage case notes and transcriptions. Generate AI-powered medical summaries from consultation data.
            </p>
          </div>
          <Separator />
          <div>
            <h3 className="font-medium">Authentication</h3>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              Supports both API key and JWT access token authentication, with multi-tenant isolation and user impersonation.
            </p>
          </div>
        </div>
      </section>

      <section id="packages">
        <h2 className="text-xl font-semibold tracking-tight">Packages</h2>
        <p className="text-muted-foreground mt-1.5 text-sm leading-6">The SDK is modular. Install only what you need.</p>
        <div className="bg-muted/50 mt-3 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-2 text-left font-medium">Package</th>
                <th className="px-4 py-2 text-left font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-xs">@arcaai/vox</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Full SDK — sessions, audio, context, summaries</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-xs">@arcaai/room</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Audio track management and processing pipeline</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-xs">@arcaai/stt</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Speech-to-text with local Whisper engine</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-xs">@arcaai/vad</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Voice Activity Detection using Silero VAD v5</td>
              </tr>
              <tr>
                <td className="px-4 py-2">
                  <code className="font-mono text-xs">@arcaai/noise-filter</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">AI noise cancellation via RNNoise WASM</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="service-status" className="flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Service Status</h2>
          <p className="text-muted-foreground mt-1.5 mb-3 text-sm leading-6">Live health status of the backend services powering this playground.</p>
          <ServiceStatusGrid />
        </div>

        {(tenantId || isSuperAdmin) && (
          <div>
            <h3 className="text-lg font-semibold tracking-tight">{tenantId ? 'Your Tenant' : 'Global Tenant'}</h3>
            <div className="mt-2 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Building2 className="text-muted-foreground size-4" />
                <span className="text-sm font-medium">{tenantName || tenantKey || (tenantId ? tenantId.slice(0, 8) + '\u2026' : 'Global')}</span>
                {tenantKey && <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{tenantKey}</code>}
                {isSuperAdmin && !tenantId && (
                  <Badge variant="outline" className="text-muted-foreground">
                    Global
                  </Badge>
                )}
              </div>

              {tenantConfig ? (
                <div className="flex flex-wrap items-center gap-2">
                  {tenantConfig.defaultSttModel && <Badge variant="secondary">STT: {tenantConfig.defaultSttModel}</Badge>}
                  {tenantConfig.defaultSmrProvider && (
                    <Badge variant="secondary">
                      SMR: {tenantConfig.defaultSmrProvider}
                      {tenantConfig.defaultSmrModel && ` / ${tenantConfig.defaultSmrModel}`}
                    </Badge>
                  )}
                  {tenantConfig.defaultLanguage && <Badge variant="secondary">Lang: {tenantConfig.defaultLanguage}</Badge>}
                  {Object.entries(tenantConfig.features).map(([key, enabled]) => (
                    <Badge key={key} variant="outline" className={enabled ? 'border-primary/30 text-primary' : 'text-muted-foreground'}>
                      {enabled ? <Check className="mr-1 size-3" /> : <X className="mr-1 size-3" />}
                      {key.replace(/([A-Z])/g, ' $1').trim()}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-5 w-36 rounded-full" />
                  <Skeleton className="h-5 w-44 rounded-full" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              )}
            </div>

            {isTenantAdmin && (
              <div id="tenant-settings" className="mt-6">
                <div className="flex items-center gap-2">
                  <Settings2 className="text-muted-foreground size-5" />
                  <h3 className="text-lg font-semibold tracking-tight">Tenant Settings</h3>
                  <Badge variant="outline" className="text-muted-foreground ml-1">
                    <Shield className="mr-1 size-3" />
                    Admin
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-1.5 mb-4 text-sm leading-6">
                  Full tenant configuration loaded from the server. Visible to tenant administrators only.
                </p>
                <TenantSettingsPanel
                  tenantConfig={tenantConfig}
                  rawConfigs={rawConfigs}
                  onSave={handleSaveConfigs}
                  isSaving={updateMutation.isPending}
                />
              </div>
            )}
          </div>
        )}
      </section>
    </DocsLayout>
  );
}

'use client';

import { Separator } from '@arcaai/ui/components/shadcn/separator';
import type { ProviderService, ReadinessEngine } from '../api/types';
import { useInferenceReadiness } from '../api/hooks';
import { ProviderCredentialCard } from './provider-credential-card';
import { ProviderCredentialsTabs } from './provider-credentials-tabs';
import { BUILT_IN_ENGINE_CARDS, MODEL_REGISTRY_CARDS } from './provider-meta';

/**
 * `lmstudio` is the alias some seeded rows still carry beside `lm-studio`, and
 * the readiness sweep folds one into the other. Matching on both keeps a card
 * from reading "not measured" because the snapshot spelled it the other way.
 */
function readinessFor(engines: readonly ReadinessEngine[] | undefined, provider: string): ReadinessEngine | undefined {
  if (!engines) return undefined;
  const aliases = provider === 'lm-studio' ? ['lm-studio', 'lmstudio'] : [provider];
  return engines.find((engine) => aliases.includes(engine.provider));
}

function SectionHeading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <div>
      <h2 id={id} className="text-sm font-medium">
        {title}
      </h2>
      <p className="text-muted-foreground text-xs">{description}</p>
    </div>
  );
}

/**
 * THE PLATFORM VIEW of `/ai-providers` (TASK-932 §3.5).
 *
 * Three sections, in the order a platform admin needs them, and the split is not
 * cosmetic — the three answer different questions and only one of them is about
 * a tenant at all:
 *
 *  1. **Built-in inference services.** The engines this deployment RUNS. Their
 *     SYSTEM rows have always existed (the seed writes them, `apps/text`
 *     resolves its base URL from them), but the screen mirrored
 *     `CLOUD_BYO_PROVIDERS` — the list of what a TENANT may bring — so the
 *     endpoints an operator most needs to change had an API and no button. This
 *     section is that button, plus the readiness the sweep already measures and
 *     a reset to the shipped default.
 *  2. **Platform default cloud connections.** The vendor accounts the PLATFORM
 *     pays for, which a tenant inherits when it has no opinion of its own. Same
 *     cards a tenant sees, one tier up.
 *  3. **Model registry.** The weight-FETCH plane, which is not inference at all:
 *     a Hugging Face token for gated repos, and the object store the weights
 *     live in. Blank is a configured state here, not an absence — see the card.
 *
 * Built-ins come FIRST deliberately: the owner's report was that the weight
 * store and the engines were unfindable, and a tab bar whose first tab is a
 * vendor account is where they were hiding.
 */
export function PlatformProviderSections({ tenantId, enabled = true }: { tenantId?: string; enabled?: boolean }) {
  // Readiness is an OBSERVATION, never a gate: a failed or cold read leaves the
  // cards without a badge, and every control on them keeps working.
  const readiness = useInferenceReadiness(enabled);
  const engines = readiness.data?.engines;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="built-in-inference">
        <SectionHeading
          id="built-in-inference"
          title="Built-in inference services"
          description="Engines this platform runs itself. Endpoint and availability are platform configuration — no tenant can bring an account for one, and every tenant is served by these."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          {BUILT_IN_ENGINE_CARDS.map((meta) => (
            <ProviderCredentialCard
              key={meta.id}
              service={'llm' satisfies ProviderService}
              meta={meta}
              tenantId={tenantId}
              tier="platform"
              readiness={readinessFor(engines, meta.id)}
              resettable
              enabled={enabled}
            />
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3" aria-labelledby="platform-cloud">
        <SectionHeading
          id="platform-cloud"
          title="Platform default cloud connections"
          description="Vendor accounts the platform pays for. A tenant with no connection of its own inherits these; a tenant with its own key wins outright; a tenant that disables one vetoes it in both tiers."
        />
        <ProviderCredentialsTabs tenantId={tenantId} tier="platform" enabled={enabled} />
      </section>

      <Separator />

      <section className="flex flex-col gap-3" aria-labelledby="model-registry">
        <SectionHeading
          id="model-registry"
          title="Model registry (built-in)"
          description="Credentials the platform uses to FETCH model weights — not to run inference. Set once, for every tenant."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          {MODEL_REGISTRY_CARDS.map((meta) => (
            <ProviderCredentialCard
              key={meta.id}
              service={'model-registry' satisfies ProviderService}
              meta={meta}
              tenantId={tenantId}
              tier="platform"
              resettable
              enabled={enabled}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

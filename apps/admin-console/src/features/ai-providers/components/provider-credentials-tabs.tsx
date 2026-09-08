'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PROVIDER_SERVICES, isProviderService, type ProviderService } from '../api/types';
import { ProviderCredentialsTab } from './provider-credentials-tab';
import { cloudConfigurableServices } from './provider-meta';
import type { ProviderTier } from './use-provider-scope';

/**
 * Tab labels. The LIST is derived (`PROVIDER_SERVICES`, pinned to the gateway's
 * `:service` OpenAPI enum); only the human label is authored here.
 *
 * `Record<ProviderService, string>` is load-bearing: when the gateway widens
 * the union and `services.ts` follows, this map stops type-checking until a
 * label exists for the new capability.
 */
const TAB_LABEL: Record<ProviderService, string> = {
  llm: 'Text generation',
  stt: 'Speech-to-text',
  tts: 'Text-to-speech',
  embeddings: 'Embeddings',
  rerank: 'Rerank',
  vector: 'Vector store',
  'model-registry': 'Model registry',
};

const DEFAULT_SERVICE: ProviderService = 'llm';

/**
 * The service × provider grid of the `/ai-providers` screen — the ONE
 * authoritative BYO-credential editor over `admin/providers/:service/:provider`
 * (rule 13). `tenantId` is the tier the screen resolved from the working tenant
 * and parameterises every card.
 *
 * TASK-932 R-12 dropped the tabs that carry no vendor card. `rerank` lists no
 * cloud provider at all — the only reranker is the platform's own TEI service —
 * and `model-registry` is the platform's weight-fetch plane, which now has its
 * own section on the platform screen. Both were two clicks to a paragraph
 * explaining that there is nothing here.
 *
 * The service picker uses its own query param (`?psvc=`) — kept after the
 * `?scope=` tier state was removed, so existing deep links still land on the
 * right capability.
 */
export function ProviderCredentialsTabs({
  tenantId,
  tier = 'tenant',
  enabled = true,
}: {
  tenantId?: string;
  tier?: ProviderTier;
  enabled?: boolean;
}) {
  const services = cloudConfigurableServices(PROVIDER_SERVICES);
  const fallback = services[0] ?? DEFAULT_SERVICE;
  const [svcParam, setSvcParam] = useQueryState('psvc', parseAsString.withDefault(fallback));
  // A deep link to a tab this tier does not render must not leave the panel
  // blank — it falls back to the first tab the tier does have.
  const service = isProviderService(svcParam) && services.includes(svcParam) ? svcParam : fallback;

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col gap-4"
      value={service}
      onValueChange={(next) => void setSvcParam(next === fallback ? null : next)}
    >
      {/* Seven triggers overflow a narrow viewport; the list scrolls rather than
          wrapping into an unreadable second row. */}
      <TabsList variant="line" className="max-w-full overflow-x-auto">
        {services.map((svc) => (
          <TabsTrigger key={svc} value={svc}>
            {TAB_LABEL[svc]}
          </TabsTrigger>
        ))}
      </TabsList>
      {services.map((svc) => (
        <TabsContent key={svc} value={svc}>
          <ProviderCredentialsTab service={svc} tenantId={tenantId} tier={tier} enabled={enabled} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PROVIDER_SERVICES, isProviderService, type ProviderService } from '../api/types';
import { ProviderCredentialsTab } from './provider-credentials-tab';

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
 * (rule 13). TASK-862 promoted it from a tab of the dissolved `/ai-platform`
 * hub to the body of its own screen; `tenantId` is the tier the screen's
 * control selected and parameterises every card.
 *
 * The service picker uses its own query param (`?psvc=`) so it never collides
 * with the screen's `?scope=` tier state.
 */
export function ProviderCredentialsTabs({ tenantId, enabled = true }: { tenantId?: string; enabled?: boolean }) {
  const [svcParam, setSvcParam] = useQueryState('psvc', parseAsString.withDefault(DEFAULT_SERVICE));
  const service = isProviderService(svcParam) ? svcParam : DEFAULT_SERVICE;

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col gap-4"
      value={service}
      onValueChange={(next) => void setSvcParam(next === DEFAULT_SERVICE ? null : next)}
    >
      {/* Seven triggers overflow a narrow viewport; the list scrolls rather than
          wrapping into an unreadable second row. */}
      <TabsList variant="line" className="max-w-full overflow-x-auto">
        {PROVIDER_SERVICES.map((svc) => (
          <TabsTrigger key={svc} value={svc}>
            {TAB_LABEL[svc]}
          </TabsTrigger>
        ))}
      </TabsList>
      {PROVIDER_SERVICES.map((svc) => (
        <TabsContent key={svc} value={svc}>
          <ProviderCredentialsTab service={svc} tenantId={tenantId} enabled={enabled} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

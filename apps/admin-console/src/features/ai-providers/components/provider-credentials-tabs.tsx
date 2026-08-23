'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PROVIDER_SERVICES, isProviderService, type ProviderService } from '../api/types';
import { ProviderCredentialsTab } from './provider-credentials-tab';

/**
 * Tab labels. The LIST is derived (`PROVIDER_SERVICES`, pinned to the gateway's
 * `:service` OpenAPI enum); only the human label is authored here, because a
 * display string is genuinely a console concern and the contract carries none.
 *
 * `Record<ProviderService, string>` is load-bearing: when the gateway widens
 * the union and `services.ts` follows, this map stops type-checking until a
 * label exists for the new capability — the tab bar cannot silently render a
 * blank trigger.
 */
const TAB_LABEL: Record<ProviderService, string> = {
  llm: 'LLM',
  stt: 'STT',
  tts: 'TTS',
  embeddings: 'Embeddings',
  rerank: 'Rerank',
  vector: 'Vector DB',
};

const DEFAULT_SERVICE: ProviderService = 'llm';

/**
 * Providers tab body — the bring-your-own credential editor over the unified
 * `admin/providers/:service/:provider` plane.
 *
 * Extracted from the retired standalone `/ai-providers` screen so the
 * `/ai-configuration` hub can compose it as its "Providers" tab.
 * This is the ONE authoritative BYO-credential editor (rule 13); the former
 * per-capability credential tabs on `/stt-config`, `/tts-config` and the
 * read-only summary on `/ai-configuration` were removed in favour of it.
 *
 * TASK-799 Phase 4 (E.3): the tab list was a hand-typed `['llm','stt','tts']`
 * that had been stale since P1-C.1 widened the plane to six capabilities. It
 * now iterates the derived list, so `embeddings`, `rerank` and `vector` — which
 * had a working API and no button — are reachable, and the next widening
 * arrives here by regenerating the OpenAPI projection rather than by someone
 * remembering this file exists.
 *
 * The service picker uses a NESTED query param (`?psvc=`) so it never collides
 * with the hub's top-level `?tab=` state.
 */
export function ProviderCredentialsTabs() {
  const [svcParam, setSvcParam] = useQueryState('psvc', parseAsString.withDefault(DEFAULT_SERVICE));
  const service = isProviderService(svcParam) ? svcParam : DEFAULT_SERVICE;

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col gap-4"
      value={service}
      onValueChange={(next) => void setSvcParam(next === DEFAULT_SERVICE ? null : next)}
    >
      {/* Six triggers overflow a narrow viewport; the list scrolls rather than
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
          <ProviderCredentialsTab service={svc} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

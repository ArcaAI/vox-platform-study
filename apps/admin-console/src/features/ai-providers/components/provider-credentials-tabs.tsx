'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import type { ProviderService } from '../api/types';
import { ProviderCredentialsTab } from './provider-credentials-tab';

const SERVICE_TABS: readonly ProviderService[] = ['llm', 'stt', 'tts'];

const TAB_LABEL: Record<ProviderService, string> = {
  llm: 'LLM',
  stt: 'STT',
  tts: 'TTS',
};

/**
 * Providers tab body — the LLM / STT / TTS bring-your-own credential editor
 * over the unified `admin/providers/:service/:provider` plane.
 *
 * Extracted from the retired standalone `/ai-providers` screen so the
 * `/ai-configuration` hub can compose it as its "Providers" tab.
 * This is the ONE authoritative BYO-credential editor (rule 13); the former
 * per-capability credential tabs on `/stt-config`, `/tts-config` and the
 * read-only summary on `/ai-configuration` were removed in favour of it.
 *
 * The service picker uses a NESTED query param (`?psvc=`) so it never collides
 * with the hub's top-level `?tab=` state.
 */
export function ProviderCredentialsTabs() {
  const [svcParam, setSvcParam] = useQueryState('psvc', parseAsString.withDefault('llm'));
  const service = (SERVICE_TABS as readonly string[]).includes(svcParam) ? (svcParam as ProviderService) : 'llm';

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col gap-4"
      value={service}
      onValueChange={(next) => void setSvcParam(next === 'llm' ? null : next)}
    >
      <TabsList variant="line">
        {SERVICE_TABS.map((svc) => (
          <TabsTrigger key={svc} value={svc}>
            {TAB_LABEL[svc]}
          </TabsTrigger>
        ))}
      </TabsList>
      {SERVICE_TABS.map((svc) => (
        <TabsContent key={svc} value={svc}>
          <ProviderCredentialsTab service={svc} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

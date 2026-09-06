'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { GuardrailPanel } from './guardrail-panel';
import { InstructionsPanel } from './instructions-panel';
import { NlpPanel } from './nlp-panel';
import { ReadinessPanel } from './readiness-panel';

const TAB_VALUES = ['readiness', 'guardrail', 'nlp', 'instructions'] as const;

const DEFAULT_TAB = 'readiness';

/**
 * AI services (/ai-services, tier 10-19).
 *
 * The console home for the platform's read-only AI backends: the readiness
 * observation across every engine, service and model (TASK-890 §3.12), the
 * guardrail service's health + config documents, the NLP service's per-model
 * health, and the effective agentic instruction set. Everything here is
 * READ-ONLY by design — neither Python service exposes config writes, so the
 * gateway offers none (config changes are deploy-time settings).
 *
 * Readiness LANDS FIRST because it is the only tab that answers the question an
 * operator opens this screen with — can the platform serve right now? The other
 * three are per-backend documents you go looking for.
 *
 * Shape ownership: the Guardrail and NLP tabs render UPSTREAM-OWNED documents
 * proxied verbatim through the gateway. They are never validated client-side —
 * see the defensive-rendering note at the top of `guardrail-panel.tsx`.
 *
 * Tenancy: the screen sits in the `(global)` route group, but the Instructions
 * tab reads TENANT-SCOPED data (a super-admin-only screen over per-tenant
 * data). That tab carries its own working-tenant gate; the other two are
 * cross-tenant.
 */
export function AiServicesScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault(DEFAULT_TAB));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : DEFAULT_TAB;

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === DEFAULT_TAB ? null : next)}>
      <ScreenTemplate
        header={
          <PageHeader
            title="AI services"
            meta={<span>Read-only status and configuration for the inference, guardrail, NLP and agentic instruction planes</span>}
          />
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="readiness">Readiness</TabsTrigger>
            <TabsTrigger value="guardrail">Guardrail</TabsTrigger>
            <TabsTrigger value="nlp">NLP</TabsTrigger>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GET /admin/ai-services/* &middot; GET /admin/agentic/instructions
              </span>
            }
          />
        }
      >
        <TabsContent value="readiness">
          <ReadinessPanel />
        </TabsContent>
        <TabsContent value="guardrail">
          <GuardrailPanel />
        </TabsContent>
        <TabsContent value="nlp">
          <NlpPanel />
        </TabsContent>
        <TabsContent value="instructions">
          <InstructionsPanel />
        </TabsContent>
      </ScreenTemplate>
    </Tabs>
  );
}

'use client';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { TaskDefaultCard } from './task-default-card';

/**
 * TASK-506 Phase 6 — AI model defaults (/ai-model-defaults, tier 30-49,
 * working tenant). NLP task keys ONLY:
 *
 *  - `guardrail.validate` is DELIBERATELY ABSENT — not even read-only. Owner
 *    governance (2026-07-17): guardrail configuration is exclusively
 *    global-admin-managed; it renders on the platform screen (tier 10-19) and
 *    the gateway 403s tenant-admin writes.
 *  - No "reset to platform default" affordance: there is no DELETE endpoint
 *    for a task-default row, so clearing a tenant override requires a global
 *    admin acting on the row directly.
 */
export function AiModelDefaultsTenantScreen() {
  return (
    <WorkingTenantGate
      title="AI model defaults"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/ai-task-defaults
        </span>
      }
    >
      <ScreenTemplate
        header={
          <PageHeader
            title="AI model defaults"
            meta={<span>tenant overrides for the NLP task defaults &mdash; the platform default applies until a row is saved</span>}
          />
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GET /admin/ai-task-defaults
              </span>
            }
          />
        }
      >
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <TaskDefaultCard
            taskKey="nlp.ner"
            title="Medical NER model"
            description="Token classification model used for medical entity extraction in this tenant."
          />
          <TaskDefaultCard
            taskKey="nlp.classification"
            title="Classification model"
            description="Text classification / diagnosis-suggestion model used in this tenant."
          />
        </div>
      </ScreenTemplate>
    </WorkingTenantGate>
  );
}

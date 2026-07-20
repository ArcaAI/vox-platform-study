'use client';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { SYSTEM_TENANT_ID } from '../api/types';
import { TaskDefaultCard } from './task-default-card';

/**
 * TASK-506 Phase 6 — AI task defaults (platform) (/ai-task-defaults, tier
 * 10-19, GLOBAL_ADMIN only). Edits the SYSTEM-tenant platform-default rows for
 * ALL THREE task keys by pinning `?tenantId=` to the SYSTEM tenant.
 *
 * EVERY task key edited here is global-admin-only on write — the service guards
 * all four prefixes (`guardrail.` / `smr.` / `nlp.` / `harness.`, see
 * `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` in
 * `packages/applications/src/services/ai-task-default/constants.ts`) and the
 * gateway 403s a tenant admin's write to any of them (owner governance
 * directive 2026-07-17). Tenants only CONSUME the platform default.
 */
export function AiTaskDefaultsPlatformScreen() {
  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="AI task defaults (platform)"
          meta={<span>SYSTEM-tenant platform defaults &mdash; global-admin-only; tenants receive the platform default</span>}
        />
      }
      footer={
        <StatusFooter
          end={
            <span aria-hidden className="font-mono">
              GET /admin/ai-task-defaults?tenantId=SYSTEM
            </span>
          }
        />
      }
    >
      <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <TaskDefaultCard
          taskKey="guardrail.validate"
          title="Guardrail model — platform-controlled (global admins only)"
          description="Safety validation model for every tenant. Tenant admins cannot change any guardrail configuration."
          tenantId={SYSTEM_TENANT_ID}
        />
        <TaskDefaultCard
          taskKey="nlp.ner"
          title="Medical NER model"
          description="Platform default for token classification (medical entity extraction). Global-admin-only; tenants receive the platform default."
          tenantId={SYSTEM_TENANT_ID}
        />
        <TaskDefaultCard
          taskKey="nlp.classification"
          title="Classification model"
          description="Platform default for text classification / diagnosis suggestion. Global-admin-only; tenants receive the platform default."
          tenantId={SYSTEM_TENANT_ID}
        />
      </div>
    </ScreenTemplate>
  );
}

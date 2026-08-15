'use client';

import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { SYSTEM_TENANT_ID } from '../api/types';
import { TaskDefaultCard } from './task-default-card';

/**
 * AI task defaults (platform) (/ai-task-defaults, tier
 * 10-19, SUPER_ADMIN only). Edits the SYSTEM-tenant platform-default rows for
 * ALL THREE task keys by pinning `?tenantId=` to the SYSTEM tenant.
 *
 * EVERY task key edited here is global-admin-only on write — the service guards
 * all four prefixes (`guardrail.` / `smr.` / `nlp.` / `harness.`, see
 * `SUPER_ADMIN_ONLY_TASK_PREFIXES` in
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
          // The pickers below only offer models that exist in the
          // registry; this is the way out to add one (incl. discovering what the
          // serving engines already host).
          actions={
            <Button asChild variant="outline">
              <Link href="/ai-models">
                <IconExternalLink aria-hidden />
                Manage models
              </Link>
            </Button>
          }
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

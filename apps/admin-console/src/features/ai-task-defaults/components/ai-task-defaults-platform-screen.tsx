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
 * `nlp.*`/`harness.*` are global-admin-only on write — the service guards
 * those two prefixes (`GLOBAL_ADMIN_ONLY_TASK_PREFIXES` in
 * `packages/applications/src/services/ai-task-default/constants.ts`) and the
 * gateway 403s a tenant admin's write to either. Tenants only CONSUME the
 * platform default for those keys.
 *
 * `guardrail.*` left that set in TASK-735 Phase 0 (owner decision
 * 2026-08-16, reversing the 2026-07-17 directive): a tenant admin MAY now
 * select their own guardrail model via the API, subject to the D2
 * platform-approved-list floor (the slug must be a SYSTEM-tenant AiModel
 * row — this screen IS that catalog). This screen still edits the SYSTEM
 * (platform-default) row that tenants inherit absent their own selection; a
 * dedicated tenant-facing guardrail picker is not yet built (see
 * `effective-models-table.tsx`, still read-only for guardrail.*).
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
          title="Guardrail model — platform default"
          description="Safety validation model used when a tenant has not selected its own. Tenant admins may select their own guardrail model from this platform-approved catalog via the API."
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

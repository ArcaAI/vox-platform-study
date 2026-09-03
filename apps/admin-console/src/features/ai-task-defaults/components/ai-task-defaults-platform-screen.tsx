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
 * all five keys below by pinning `?tenantId=` to the SYSTEM tenant.
 *
 * `nlp.*`/`harness.*` are super-admin-only on write — the service guards
 * those two prefixes (`SUPER_ADMIN_ONLY_TASK_PREFIXES` in
 * `packages/applications/src/services/ai-task-default/constants.ts`) and the
 * gateway 403s a tenant admin's write to either. Tenants only CONSUME the
 * platform default for those keys.
 *
 * `guardrail.*` left that set in (owner decision
 * 2026-08-16, reversing the 2026-07-17 directive): a tenant admin MAY now
 * select their own guardrail model via the API, subject to the D2
 * platform-approved-list floor (the slug must be a SYSTEM-tenant AiModel
 * row — this screen IS that catalog). This screen still edits the SYSTEM
 * (platform-default) row that tenants inherit absent their own selection; a
 * dedicated tenant-facing guardrail picker is not yet built (see
 * `effective-models-table.tsx`, still read-only for guardrail.*).
 *
 * `guardrail.pii` / `guardrail.pii.spans` are the exception inside that
 * prefix: they are SUPER_ADMIN-only by KEY (`SUPER_ADMIN_ONLY_TASK_KEYS`),
 * because PII redaction is a PHI-protection control where one vetted model per
 * platform is the point. Owner decision 2026-08-30: they get a real editor
 * HERE (this screen is exactly the tier-10-19 SYSTEM-row surface for that
 * class of key) rather than remaining API-only. They stay read-only rows on
 * the tenant `/ai-configuration` table, which is where tenants SEE the
 * selection they inherit.
 */
export function AiTaskDefaultsPlatformScreen() {
  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="AI task defaults (platform)"
          meta={<span>SYSTEM-tenant platform defaults &mdash; super-admin-only; tenants receive the platform default</span>}
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
          taskKey="guardrail.pii"
          title="PII redaction model — platform default"
          description="Span extractor backing guardrail's PII redaction. Super-admin-only: one vetted model serves every tenant (PHI-protection control, no tenant BYO)."
          tenantId={SYSTEM_TENANT_ID}
        />
        <TaskDefaultCard
          taskKey="guardrail.pii.spans"
          title="PII span-detection model — platform default"
          description="Span extractor backing guardrail's PII span reporting. Super-admin-only, same PHI-protection posture as the redaction model."
          tenantId={SYSTEM_TENANT_ID}
        />
        <TaskDefaultCard
          taskKey="nlp.ner"
          title="Medical NER model"
          description="Platform default for token classification (medical entity extraction). Super-admin-only; tenants receive the platform default."
          tenantId={SYSTEM_TENANT_ID}
        />
        <TaskDefaultCard
          taskKey="nlp.classification"
          title="Classification model"
          description="Platform default for text classification / diagnosis suggestion. Super-admin-only; tenants receive the platform default."
          tenantId={SYSTEM_TENANT_ID}
        />
      </div>
    </ScreenTemplate>
  );
}

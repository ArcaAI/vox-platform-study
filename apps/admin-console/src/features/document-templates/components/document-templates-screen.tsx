'use client';

/**
 * Document Templates screen (tier 30-49) — the tenant's catalog of clinical
 * document SHAPES. Owns exactly one resource: `DocumentTemplate`.
 *
 * Tenant-scoped: elevated sessions must pick a working tenant before any query
 * mounts; tenant admins are pinned and pass straight through
 * (`WorkingTenantGate`).
 */

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { DocumentTemplatesList } from './document-templates-list';

function DocumentTemplatesScreenBody() {
  return (
    <ScreenTemplate
      header={<PageHeader title="Document Templates" meta={<span>clinical document shapes for this tenant</span>} />}
      footer={
        <StatusFooter
          start={<span>Up to date</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/document-templates
            </span>
          }
        />
      }
    >
      <DocumentTemplatesList />
    </ScreenTemplate>
  );
}

export function DocumentTemplatesScreen() {
  return (
    <WorkingTenantGate
      title="Document Templates"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/document-templates
        </span>
      }
      description="Document templates are administered per tenant. Pick a working tenant from the switcher in the top bar to load its catalog."
    >
      <DocumentTemplatesScreenBody />
    </WorkingTenantGate>
  );
}

'use client';

/**
 * Context Schemas screen (tier 30-49) — the first schema builder in
 * the product. Owns exactly one resource: `ConsultationContextSchema`
 * . Tenant-scoped: elevated sessions must pick a working tenant
 * before any query mounts; tenant admins are pinned and pass straight
 * through (`WorkingTenantGate`).
 */

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { ContextSchemasList } from './context-schemas-list';

function ContextSchemasScreenBody() {
  return (
    <ScreenTemplate
      header={<PageHeader title="Context Schemas" meta={<span>consultation context vocabulary for this tenant</span>} />}
      footer={
        <StatusFooter
          start={<span>Up to date</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/consultation-context-schemas
            </span>
          }
        />
      }
    >
      <ContextSchemasList />
    </ScreenTemplate>
  );
}

export function ContextSchemasScreen() {
  return (
    <WorkingTenantGate
      title="Context Schemas"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/consultation-context-schemas
        </span>
      }
      description="Context schemas are administered per tenant. Pick a working tenant from the switcher in the top bar to load its catalog."
    >
      <ContextSchemasScreenBody />
    </WorkingTenantGate>
  );
}

'use client';

import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { AgentsTab } from './agents-tab';

/**
 * Frame 32 — Agent Catalog (tier 30-49, capabilities-matrix row 25).
 *
 * Owns exactly one resource: `DepartmentAgent`. The "Agent Templates" and
 * "Governance" tabs this screen used to carry moved to `/prompt-templates`
 * when prompt instruction templates got their own route —
 * `PromptTemplate` now has one authoritative editor instead of being a
 * secondary tab of a screen named after a different resource (rule 13).
 * Existing deep links keep working: `?template=` / `?tab=governance` are
 * honoured by the new screen and `/prompt-studio` redirects there.
 *
 * Tenant-scoped: elevated sessions must pick a working tenant before any query
 * mounts; tenant admins are pinned and pass straight through.
 */
function AgentsScreenBody() {
  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Agent Catalog"
          meta={<span>department agents for this tenant</span>}
          actions={
            <Button asChild variant="outline">
              <Link href="/prompt-templates">
                <IconExternalLink aria-hidden />
                Open prompt templates
              </Link>
            </Button>
          }
        />
      }
      footer={
        <StatusFooter
          start={<span>Up to date</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/department-agents
            </span>
          }
        />
      }
    >
      <AgentsTab />
    </ScreenTemplate>
  );
}

export function AgentsScreen() {
  return (
    <WorkingTenantGate
      title="Agent Catalog"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/department-agents
        </span>
      }
      description="Agents are administered per tenant. Pick a working tenant from the switcher in the top bar to load its catalog."
    >
      <AgentsScreenBody />
    </WorkingTenantGate>
  );
}

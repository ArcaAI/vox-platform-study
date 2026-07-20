'use client';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { EmptyState } from '@/shared/state/empty-state';
import { IconSettings } from '@tabler/icons-react';

/**
 * Tenant AI model defaults screen.
 *
 * Guardrail / NLP / SMR / Harness model selection is GLOBAL_ADMIN-only and is
 * edited on the platform AI task-defaults surface. Tenant admins keep STT
 * pipeline selection, DNA styles/reports/schedulers, and Case Notes templates
 * on their dedicated screens — this page no longer hosts NLP model pickers.
 */
export function AiModelDefaultsTenantScreen() {
  return (
    <WorkingTenantGate
      title="AI model defaults"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          platform-managed
        </span>
      }
    >
      <ScreenTemplate
        header={
          <PageHeader
            title="AI model defaults"
            meta={<span>Guardrail, NLP, SMR, and Harness models are managed by global administrators</span>}
          />
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GLOBAL_ADMIN only
              </span>
            }
          />
        }
      >
        <EmptyState
          icon={IconSettings}
          title="Platform-managed AI models"
          description="Default models for Guardrail, NLP, SMR, and Harness are configured by global administrators. Your tenant uses the platform defaults at runtime. To personalize audio transcription, choose among the shared ASR pipelines on the Audio pipelines screen; DNA writing styles and Case Notes templates remain tenant-editable."
        />
      </ScreenTemplate>
    </WorkingTenantGate>
  );
}

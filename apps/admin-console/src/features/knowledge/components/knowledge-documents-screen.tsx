'use client';

/**
 * Knowledge Base screen (tier 30-49) — the institutional-RAG
 * knowledge corpus, the platform's only real "memory" concept (see the
 * for why episodic/session-artifact memory is out of
 * scope: it does not exist in the code today). Tenant-scoped: elevated
 * sessions must pick a working tenant before any query mounts; tenant admins
 * are pinned and pass straight through (`WorkingTenantGate`).
 *
 * This file is the tenant gate only — it holds no page frame by design. The
 * `ScreenTemplate` (`contentMode="fill"` around the `VirtualizedDataGrid`) and
 * its `StatusFooter` live one level down in `KnowledgeDocumentsList`, past the
 * gate, so the NoTenant state renders the gate's own frame instead. Wrapping a
 * second `ScreenTemplate` here would nest two page frames (and two scroll
 * containers) — see rule 11 §1.
 */

import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { KnowledgeDocumentsList } from './knowledge-documents-list';

export function KnowledgeDocumentsScreen() {
  return (
    <WorkingTenantGate
      title="Knowledge Base"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/knowledge/documents
        </span>
      }
      description="Institutional knowledge documents are administered per tenant. Pick a working tenant from the switcher in the top bar to load its catalog."
    >
      <KnowledgeDocumentsList />
    </WorkingTenantGate>
  );
}

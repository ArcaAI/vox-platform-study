/**
 * TASK-1036 §3.3 / D-2 — the management screen's bulk verbs. There is NO bulk route: each verb
 * runs client-side, one lineage at a time and in order, and every lineage reports its own result,
 * so one failure never hides the rest and a partial run is visible rather than silent.
 *
 * Export is ONE JSON FILE PER LINEAGE (several downloads), not a zip: the console has no archive
 * dependency and adding one for this verb is not worth a new runtime package.
 */
import {
  deleteWorkflowDefinition,
  deprecateDefinition,
  exportWorkflowDefinition,
  listWorkflowDefinitionVersions,
  listWorkflowDefinitions,
  publishWorkflowDefinition,
} from '../../api/client';
import type { WorkflowDefinition, WorkflowLineage } from '../../api/types';

export type BulkAction = 'publish' | 'unpublish' | 'export' | 'delete';

export type BulkItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BulkItem {
  slug: string;
  name: string;
  status: BulkItemStatus;
  /** What happened — the success summary or the failure reason, verbatim from the gateway where it gave one. */
  message?: string;
}

export const BULK_ACTION_LABEL: Record<BulkAction, string> = {
  publish: 'Publish',
  unpublish: 'Unpublish',
  export: 'Export',
  delete: 'Delete all versions',
};

export function initialItems(lineages: readonly WorkflowLineage[]): BulkItem[] {
  return lineages.map((lineage) => ({ slug: lineage.slug, name: lineage.name, status: 'pending' as const }));
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Saves one bundle through the browser. Nothing is re-serialised beyond pretty-printing. */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function versionsOf(lineage: WorkflowLineage): Promise<WorkflowDefinition[]> {
  const anchor = lineage.active?.id ?? lineage.draft?.id;
  if (anchor) return listWorkflowDefinitionVersions(anchor);
  // Every version deprecated and no open draft: no id on the register row, so read by slug.
  const page = await listWorkflowDefinitions({ filters: `slug[iequals]:${lineage.slug}`, limit: 100, page: 1 });
  return page.data.filter((row) => row.slug === lineage.slug);
}

/** Resolves with the success message, or throws with the reason the lineage was not processed. */
async function applyToLineage(action: BulkAction, lineage: WorkflowLineage): Promise<string> {
  switch (action) {
    case 'publish': {
      const draft = lineage.draft;
      if (!draft || draft.status !== 'VALIDATED') {
        throw new Error(draft ? `No VALIDATED draft to publish (newest draft v${draft.versionNumber} is ${draft.status}).` : 'No VALIDATED draft to publish.');
      }
      await publishWorkflowDefinition(draft.id);
      return `Published v${draft.versionNumber} and made it active.`;
    }
    case 'unpublish': {
      if (!lineage.active) throw new Error('No active version to unpublish.');
      await deprecateDefinition(lineage.active.id);
      return `Unpublished v${lineage.active.versionNumber}; the workflow now serves nothing.`;
    }
    case 'export': {
      const target = lineage.active ?? lineage.draft;
      if (!target) throw new Error('No active version or open draft to export.');
      const bundle = await exportWorkflowDefinition(target.id);
      downloadJson(`workflow-${lineage.slug}-v${target.versionNumber}.json`, bundle);
      return `Exported v${target.versionNumber}.`;
    }
    case 'delete': {
      const versions = await versionsOf(lineage);
      // OD-14: the active version cannot be deleted, so it is retired first — and a failure there
      // stops the lineage before anything is deleted.
      const active = versions.find((version) => version.isActive);
      if (active) await deprecateDefinition(active.id);
      let deleted = 0;
      for (const version of versions) {
        try {
          await deleteWorkflowDefinition(version.id);
          deleted += 1;
        } catch (error) {
          throw new Error(`Deleted ${deleted} of ${versions.length} versions; v${version.versionNumber} failed: ${messageOf(error, 'delete refused')}`);
        }
      }
      return `Deleted ${deleted} version${deleted === 1 ? '' : 's'}${active ? ` (v${active.versionNumber} unpublished first)` : ''}.`;
    }
  }
}

/**
 * Runs `action` over `lineages` sequentially, reporting each item's transitions through
 * `onUpdate`. Never throws: a failing lineage is recorded and the run continues.
 */
export async function runBulk(action: BulkAction, lineages: readonly WorkflowLineage[], onUpdate: (slug: string, patch: Partial<BulkItem>) => void): Promise<BulkItem[]> {
  const results: BulkItem[] = [];
  for (const lineage of lineages) {
    onUpdate(lineage.slug, { status: 'running' });
    let result: Partial<BulkItem>;
    try {
      result = { status: 'done', message: await applyToLineage(action, lineage) };
    } catch (error) {
      result = { status: 'failed', message: messageOf(error, 'Failed.') };
    }
    onUpdate(lineage.slug, result);
    results.push({ slug: lineage.slug, name: lineage.name, status: 'pending', ...result });
  }
  return results;
}

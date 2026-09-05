/**
 * TASK-885 (owner #4) — reading and writing the PORTABLE BUNDLE file.
 *
 * Not to be confused with `graph-io.ts`, which moves the editor BUFFER's graph in and out of the
 * canvas. The two are different artifacts for different jobs, and the console says so in both
 * labels:
 *
 * | | `graph-io` | `bundle-io` |
 * |---|---|---|
 * | Carries | nodes + edges, nothing else | the whole definition: name, palette, graph, references |
 * | References | verbatim row ids — the tenant's own | portable keys, resolved on the way in |
 * | Crosses a tenant? | no | that is the entire point |
 *
 * The parse below is a SHAPE check only, exactly as `parseGraphJson` is: the server re-validates
 * everything that matters and refuses unresolvable references with a 409. What this buys is that
 * choosing the wrong file costs a message instead of a round trip and a confusing server error.
 */
import type { WorkflowDefinitionBundle } from '../api/types';

export const BUNDLE_EXPORT_FILENAME = (slug: string, versionNumber: number) => `${slug}.v${versionNumber}.workflow-bundle.json`;

export type ParsedBundle = { ok: true; bundle: WorkflowDefinitionBundle } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseBundleJson(text: string): ParsedBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Not valid JSON.' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'The document must be a JSON object.' };
  if (parsed.kind !== 'workflow') {
    // Names what it IS, so someone who picked an agent export or a bare graph export learns which.
    return { ok: false, reason: `This is not a workflow export (kind: ${JSON.stringify(parsed.kind ?? null)}).` };
  }
  if (parsed.schemaVersion !== 1)
    return { ok: false, reason: `Unsupported bundle version ${JSON.stringify(parsed.schemaVersion ?? null)} — expected 1.` };
  const payload = parsed.payload;
  if (!isRecord(payload)) return { ok: false, reason: 'The bundle has no payload.' };
  if (typeof payload.name !== 'string' || payload.name.length === 0) return { ok: false, reason: 'The bundle payload has no name.' };
  if (typeof payload.paletteKey !== 'string' || payload.paletteKey.length === 0)
    return { ok: false, reason: 'The bundle payload has no paletteKey.' };
  if (!isRecord(payload.graph)) return { ok: false, reason: 'The bundle payload has no graph.' };

  return { ok: true, bundle: parsed as unknown as WorkflowDefinitionBundle };
}

/** A suggested slug for the imported lineage — the platform proposes, the tenant decides. */
export function suggestImportSlug(bundle: WorkflowDefinitionBundle): string {
  const base = bundle.source?.slug ?? '';
  if (!base) return '';
  const suggestion = `${base}_imported`;
  return suggestion.length <= 48 ? suggestion : suggestion.slice(0, 48);
}

/**
 * Hand the browser a file. Kept here rather than in a shared util because the Studio is the only
 * surface that downloads anything, and `workflow-studio-editor.tsx` already carries a private
 * twin of this for the graph export — that duplication is pre-existing and deliberately not
 * refactored by this ticket (rule: touch only what you must).
 */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

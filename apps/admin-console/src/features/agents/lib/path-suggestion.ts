/**
 * TASK-1059 C-14 — "did you mean …" for a prompt variable the publish gate refused as undeclared.
 * The bound schema's `context.<kind>.<field>` paths are matched on the leaf the author typed
 * (`context.chief_complaint` → `context.intake.chief_complaint`).
 */
import type { AgentFinding } from '../api/types';

const REFERENCE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}|`((?:context|trigger)\.[\w.]+)`/;

export function suggestPaths(reference: string, paths: readonly string[]): string[] {
  const leaf = reference.split('.').pop();
  if (!leaf) return [];
  return paths.filter((path) => path !== reference && path.startsWith('context.') && path.split('.').pop() === leaf).slice(0, 3);
}

export function withPathSuggestions(findings: readonly AgentFinding[], paths: readonly { path: string }[]): AgentFinding[] {
  if (paths.length === 0) return [...findings];
  const all = paths.map((entry) => entry.path);
  return findings.map((finding) => {
    if (finding.code !== 'PROMPT_VARIABLE_UNDECLARED') return finding;
    const match = REFERENCE.exec(finding.message);
    const reference = match?.[1] ?? match?.[2];
    const suggestions = reference ? suggestPaths(reference, all) : [];
    if (suggestions.length === 0) return finding;
    return { ...finding, message: `${finding.message} Did you mean ${suggestions.map((path) => `{{${path}}}`).join(' or ')}?` };
  });
}

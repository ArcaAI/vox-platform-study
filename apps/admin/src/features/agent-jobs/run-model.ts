/**
 * TASK-407 — display model for the Agent Jobs surface. NO drawn design exists
 * (flagged in the ticket README): the surface renders the tenant's
 * `PromptUsageRecord` run history + a per-agent (template) summary with the
 * last prompt-test outcome, mirroring TASK-379/380 tenant-detail patterns.
 */

import type { PromptTemplate, PromptUsageRecord } from '@arcaai/vox';

export type ScoreColorRole = 'success' | 'warning' | 'destructive' | 'neutral';

/** One resolved run row: record ids joined to display names client-side. */
export interface AgentRunRow {
  id: string;
  templateName: string | null;
  category: string | null;
  version: number | null;
  consultationId: string | null;
  doctorId: string | null;
  departmentName: string | null;
  createdAt: string;
}

/** Join template + department names onto raw usage records (unknown → null). */
export function resolveRunRows(
  records: ReadonlyArray<PromptUsageRecord>,
  templates: ReadonlyArray<PromptTemplate>,
  deptNameById: ReadonlyMap<string, string>,
): AgentRunRow[] {
  const templateById = new Map(templates.map((t) => [t.id, t]));
  return records.map((r) => {
    const template = r.promptTemplateId ? templateById.get(r.promptTemplateId) : undefined;
    return {
      id: r.id,
      templateName: template?.name ?? null,
      category: template?.category ?? null,
      version: r.promptVersionNumber ?? null,
      consultationId: r.consultationId ?? null,
      doctorId: r.doctorId ?? null,
      departmentName: (r.departmentId && deptNameById.get(r.departmentId)) || null,
      createdAt: r.createdAt,
    };
  });
}

/** One agent (template) summary row with its last test outcome. */
export interface AgentSummaryRow {
  id: string;
  name: string;
  category: string | null;
  status: string | null;
  lastTestScore: number | null;
  lastTestAt: string | null;
}

/** Project templates into the per-agent summary, sorted by name. */
export function agentSummaryRows(templates: ReadonlyArray<PromptTemplate>): AgentSummaryRow[] {
  return templates
    .map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category ?? null,
      status: (t as { status?: string }).status ?? null,
      lastTestScore: t.lastTestScore ?? null,
      lastTestAt: t.lastTestAt ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Grade a 0–100 prompt-test score: ≥80 success, ≥50 warning, else destructive. */
export function scoreColorRole(score?: number | null): ScoreColorRole {
  if (score == null) return 'neutral';
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'destructive';
}

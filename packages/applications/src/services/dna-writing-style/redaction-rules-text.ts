// TASK-1034 R3 — the doctor's redaction/rewrite rules as a human-readable bullet list, rendered
// into the generation prompt as `dna_redaction_rules_text`.
//
// This is ADVISORY: the model may ignore an instruction, so the deterministic post-generation
// pass (harness `apply_redaction`) stays the guarantee. Pure and total — unknown or malformed
// entries are skipped, and no usable rule renders the empty string.

import type { RedactionRule } from './redaction-rules';

function isRule(value: unknown): value is RedactionRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  return (
    (rule.type === 'remove' || rule.type === 'rewrite') &&
    (rule.match === 'literal' || rule.match === 'regex' || rule.match === 'category') &&
    typeof rule.pattern === 'string' &&
    rule.pattern !== ''
  );
}

function sentence(rule: RedactionRule): string {
  const replacement = typeof rule.replacement === 'string' ? rule.replacement : undefined;
  if (rule.type === 'remove') {
    if (rule.match === 'literal') return `Never write "${rule.pattern}".`;
    if (rule.match === 'regex') return `Never write text matching the pattern /${rule.pattern}/.`;
    return `Never include ${rule.pattern}.`;
  }
  if (rule.match === 'literal') return `Always write "${rule.pattern}" as "${replacement ?? ''}".`;
  if (rule.match === 'regex') return `Write text matching the pattern /${rule.pattern}/ as "${replacement ?? ''}".`;
  return replacement !== undefined ? `Always rewrite ${rule.pattern} as "${replacement}".` : `Always rewrite ${rule.pattern} in neutral wording.`;
}

/** Render a rule list (or the persisted `{ rules }` container) as `- …` lines; `''` when none. */
export function renderDnaRedactionRulesText(input: unknown): string {
  const rules = Array.isArray(input)
    ? input
    : typeof input === 'object' && input !== null && Array.isArray((input as { rules?: unknown }).rules)
      ? (input as { rules: unknown[] }).rules
      : [];
  return rules
    .filter(isRule)
    .map((rule) => {
      const note = typeof rule.note === 'string' && rule.note.trim() ? ` (${rule.note.trim()})` : '';
      return `- ${sentence(rule)}${note}`;
    })
    .join('\n');
}

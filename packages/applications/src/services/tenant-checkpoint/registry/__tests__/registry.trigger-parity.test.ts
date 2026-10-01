import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_REGISTRY, descriptorFor } from '../registry';

const MIGRATIONS = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../../database/src/prisma/db_main/migrations',
);

/** Every migration.sql, in ledger (folder-name) order. */
function migrationSql(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((dir) => existsSync(join(MIGRATIONS, dir, 'migration.sql')))
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
}

/** The LAST `CREATE OR REPLACE FUNCTION` body of each function. */
function latestFunctionBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /CREATE OR REPLACE FUNCTION\s+(?:"?core"?\.)?"?(\w+)"?\s*\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/g;
  for (const sql of migrationSql()) {
    for (const match of sql.matchAll(re)) bodies.set(match[1], match[2]);
  }
  return bodies;
}

/** `"<col>" IS DISTINCT FROM` columns; a guard that compares none freezes the whole row (`*`). */
function guardedColumns(body: string): string[] {
  const cols = [...body.matchAll(/"(\w+)" IS DISTINCT FROM/g)].map((m) => m[1]);
  return cols.length ? [...new Set(cols)].sort() : ['*'];
}

const GUARDS: Record<string, string> = {
  workflow_definition_immutability_guard: 'WorkflowDefinition',
  agent_immutability_guard: 'Agent',
  agent_model_fallback_immutability_guard: 'AgentModelFallback',
  document_template_version_immutability_guard: 'DocumentTemplateVersion',
  agent_assignment_change_worm_guard: 'AgentAssignmentChange',
};

describe('checkpoint registry — trigger parity', () => {
  const bodies = latestFunctionBodies();

  it('knows every UPDATE/DELETE trigger the migrations create', () => {
    const triggerFns = new Set<string>();
    for (const sql of migrationSql()) {
      for (const m of sql.matchAll(/CREATE TRIGGER[\s\S]*?EXECUTE (?:FUNCTION|PROCEDURE)\s+(?:"?core"?\.)?"?(\w+)"?/g)) {
        triggerFns.add(m[1]);
      }
    }
    expect([...triggerFns].sort()).toEqual(Object.keys(GUARDS).sort());
  });

  it.each(Object.entries(GUARDS).filter(([, model]) => descriptorFor(model).policy !== 'CAPTURE_ONLY'))(
    '%s → %s: immutableColumns equal the guarded columns',
    (fn, model) => {
      const body = bodies.get(fn);
      expect(body, fn).toBeDefined();
      const d = descriptorFor(model);
      expect([...(d.immutableColumns ?? [])].sort()).toEqual(guardedColumns(body!));
      expect(d.immutableWhen, model).toBeTruthy();
    },
  );

  it('the WORM-guarded AgentAssignmentChange is never restored', () => {
    expect(bodies.has('agent_assignment_change_worm_guard')).toBe(true);
    const d = descriptorFor('AgentAssignmentChange');
    expect([d.category, d.policy, d.retire.kind]).toEqual(['LOGS', 'CAPTURE_ONLY', 'never']);
  });

  it('pins the gating predicates', () => {
    expect(descriptorFor('Agent').immutableWhen).toBe(`l."status" IN ('PUBLISHED','DEPRECATED')`);
    expect(descriptorFor('WorkflowDefinition').immutableWhen).toBe(`l."status" IN ('PUBLISHED','DEPRECATED')`);
    expect(descriptorFor('AgentModelFallback').immutableWhen).toBe(
      `EXISTS (SELECT 1 FROM core."Agent" a WHERE a."id" = l."agentId" AND a."status" IN ('PUBLISHED','DEPRECATED'))`,
    );
    const dtv = descriptorFor('DocumentTemplateVersion');
    expect([dtv.policy, dtv.retire.kind, dtv.immutableWhen]).toEqual(['RECONCILE', 'never', 'true']);
  });

  it('no other model claims immutable columns', () => {
    const claimed = CHECKPOINT_REGISTRY.filter((d) => d.immutableColumns).map((d) => d.model).sort();
    expect(claimed).toEqual(Object.values(GUARDS).filter((m) => m !== 'AgentAssignmentChange').sort());
  });
});

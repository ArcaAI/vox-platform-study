/**
 * proves the evidence fixture (`../task-773-admin-scope-map.ts`)
 * is internally consistent and still matches the real controllers on disk.
 *
 * This does NOT assert that any controller actually carries
 * `@RequiredSvcScopes` yet — that decorator is implementation
 * step, not this fixture's job. This test only proves the MAP itself is
 * trustworthy: every `adminScope` is a real, still-registered `admin:*`
 * scope; every `(file, controllerClass)` row points at a real class; there
 * are no duplicate rows; and the row count has not silently shrunk.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { API_KEY_SCOPE_REGISTRY } from '@arcaai/applications';
import { TASK_773_ADMIN_SCOPE_MAP } from '../task-773-admin-scope-map';

// Anchor on cwd, which vitest sets to either the monorepo root (root
// workspace run) or `apps/api` (filtered run) — same shortcut
// `business-plane-apikey-exemptions.test.ts` uses. The fixture's `file`
// field is repo-relative (`apps/api/src/modules/...`), so resolve UP to the
// repo root rather than down to `apps/api`.
const cwd = process.cwd();
const repoRoot = cwd.endsWith(join('apps', 'api')) ? join(cwd, '..', '..') : cwd;

/**
 * Determined in by cross-checking 276f96a32 against the live tree — see the fixture's
 * header comment.
 *
 * 64 -> 65: adds `DocumentTemplateAdminController`
 * (`admin:document-template:manage`), the clinical-document SHAPE catalog. This count is a
 * DELIBERATE-CHANGE guard, not a ceiling — a new admin controller is expected to move it, in
 * the same commit that adds the controller.
 */
// 65 -> 63: deleted `DepartmentAgentController` and
// `DepartmentAgentResyncController`, whose rows both carried
// `admin:department-agent:manage` — a scope that went with them.
const EXPECTED_ROW_COUNT = 63;

describe('TASK_773_ADMIN_SCOPE_MAP', () => {
  it('has not silently grown or shrunk', () => {
    expect(TASK_773_ADMIN_SCOPE_MAP.length).toBe(EXPECTED_ROW_COUNT);
  });

  it('carries no duplicate (file, controllerClass) pairs', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const row of TASK_773_ADMIN_SCOPE_MAP) {
      const key = `${row.file}::${row.controllerClass}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates).toEqual([]);
  });

  it.each(TASK_773_ADMIN_SCOPE_MAP.map((row) => [row.controllerClass, row] as const))(
    '%s: adminScope starts with admin: and is a live key in API_KEY_SCOPE_REGISTRY',
    (_name, row) => {
      expect(row.adminScope.startsWith('admin:')).toBe(true);
      expect(API_KEY_SCOPE_REGISTRY).toHaveProperty(row.adminScope);
    },
  );

  it.each(TASK_773_ADMIN_SCOPE_MAP.map((row) => [row.controllerClass, row] as const))(
    '%s: file exists and exports the named controller class',
    (_name, row) => {
      const path = join(repoRoot, row.file);
      expect(existsSync(path)).toBe(true);

      const source = readFileSync(path, 'utf8');
      expect(source).toContain(`export class ${row.controllerClass}`);
    },
  );
});

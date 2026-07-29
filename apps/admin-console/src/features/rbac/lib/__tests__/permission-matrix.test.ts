/**
 * TDD for the permission-matrix derivation engine.
 * The matrix is a derived, read-only view: allow → ✓, deny (inverted) → none,
 * GLOBAL-scope allow → inherited, conditions → conditional, `manage` expands to
 * every column, action aliases normalize, unknown subjects append, order is
 * deterministic.
 */

import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '../../api/types';
import { derivePermissionMatrix, MATRIX_ACTIONS, type MatrixPolicyInput } from '../permission-matrix';

function policy(overrides: Partial<MatrixPolicyInput> & { rules: PolicyRule[] }): MatrixPolicyInput {
  return {
    id: overrides.id ?? 'p-1',
    name: overrides.name ?? 'policy',
    scope: overrides.scope ?? 'TENANT',
    priority: overrides.priority ?? 10,
    rules: overrides.rules,
  };
}

function rowFor(matrix: ReturnType<typeof derivePermissionMatrix>, subject: string) {
  const row = matrix.rows.find((entry) => entry.subject === subject);
  if (!row) throw new Error(`no row for ${subject}`);
  return row;
}

describe('derivePermissionMatrix', () => {
  it('marks an allow rule as granted (✓) in the mapped column and none elsewhere', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: 'read', subject: 'Consultation' }] })]);
    const row = rowFor(matrix, 'Consultation');
    expect(row.cells.read).toBe('granted');
    expect(row.cells.create).toBe('none');
    expect(row.cells.update).toBe('none');
    expect(row.cells.delete).toBe('none');
    expect(row.cells.manage).toBe('none');
  });

  it('expands a `manage` rule to every column', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: 'manage', subject: 'Department' }] })]);
    const row = rowFor(matrix, 'Department');
    for (const action of MATRIX_ACTIONS) {
      expect(row.cells[action]).toBe('granted');
    }
  });

  // CASL serializes `action`/`subject` as string OR string[] — the gateway
  // ships array actions (e.g. DOCTOR's `["read","update","delete","list"]`).
  // The derivation must grant every listed action, not throw on `.trim`.
  it('grants every action in an array-valued `action` rule (CASL string[] form)', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: ['read', 'update', 'delete', 'list'], subject: 'Consultation' }] })]);
    const row = rowFor(matrix, 'Consultation');
    expect(row.cells.read).toBe('granted');
    expect(row.cells.update).toBe('granted');
    expect(row.cells.delete).toBe('granted');
    expect(row.cells.create).toBe('none');
    expect(row.cells.manage).toBe('none');
  });

  it('applies an array-valued `subject` rule to each listed subject', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: 'read', subject: ['Consultation', 'Department'] }] })]);
    expect(rowFor(matrix, 'Consultation').cells.read).toBe('granted');
    expect(rowFor(matrix, 'Department').cells.read).toBe('granted');
  });

  it('lets a higher-precedence deny (inverted, lower priority number) mask a lower-precedence allow', () => {
    const matrix = derivePermissionMatrix([
      policy({ id: 'deny', priority: 10, rules: [{ action: 'read', subject: 'Consultation', inverted: true }] }),
      policy({ id: 'allow', priority: 20, rules: [{ action: 'read', subject: 'Consultation' }] }),
    ]);
    expect(rowFor(matrix, 'Consultation').cells.read).toBe('none');
  });

  it('keeps the first-match allow when it outranks a later deny', () => {
    const matrix = derivePermissionMatrix([
      policy({ id: 'allow', priority: 10, rules: [{ action: 'read', subject: 'Consultation' }] }),
      policy({ id: 'deny', priority: 20, rules: [{ action: 'read', subject: 'Consultation', inverted: true }] }),
    ]);
    expect(rowFor(matrix, 'Consultation').cells.read).toBe('granted');
  });

  it('reads a GLOBAL-scope allow as inherited (◐)', () => {
    const matrix = derivePermissionMatrix([policy({ scope: 'GLOBAL', rules: [{ action: 'update', subject: 'Tenant' }] })]);
    expect(rowFor(matrix, 'Tenant').cells.update).toBe('inherited');
  });

  it('reads a conditional/field-scoped allow as conditional', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: 'read', subject: 'Patient', conditions: { departmentId: 'd-1' } }] })]);
    expect(rowFor(matrix, 'Patient').cells.read).toBe('conditional');
  });

  it('normalizes action aliases (list -> read)', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: 'list', subject: 'Consultation' }] })]);
    expect(rowFor(matrix, 'Consultation').cells.read).toBe('granted');
  });

  it('applies a wildcard `all` subject to every curated row', () => {
    const matrix = derivePermissionMatrix([policy({ scope: 'GLOBAL', rules: [{ action: 'manage', subject: 'all' }] })]);
    // Every curated row is fully inherited; no dedicated `all` row is created.
    expect(matrix.rows.some((row) => row.subject === 'all')).toBe(false);
    for (const row of matrix.rows) {
      for (const action of MATRIX_ACTIONS) {
        expect(row.cells[action]).toBe('inherited');
      }
    }
  });

  it('appends an unknown subject below the curated set with a humanized label', () => {
    const matrix = derivePermissionMatrix([policy({ rules: [{ action: 'read', subject: 'AuditLog' }] })]);
    const appended = matrix.rows[matrix.rows.length - 1];
    expect(appended.subject).toBe('AuditLog');
    expect(appended.label).toBe('Audit log');
    expect(appended.cells.read).toBe('granted');
  });

  it('produces a deterministic curated-first row order', () => {
    const first = derivePermissionMatrix([policy({ rules: [{ action: 'read', subject: 'AuditLog' }] })]);
    const second = derivePermissionMatrix([policy({ rules: [{ action: 'read', subject: 'AuditLog' }] })]);
    expect(first.rows.map((row) => row.subject)).toEqual(second.rows.map((row) => row.subject));
    expect(first.rows[0].subject).toBe('Consultation');
  });

  it('always returns the four-state legend', () => {
    const matrix = derivePermissionMatrix([]);
    expect(matrix.legend.map((entry) => entry.state)).toEqual(['granted', 'inherited', 'conditional', 'none']);
  });
});

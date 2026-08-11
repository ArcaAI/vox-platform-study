/**
 * TASK-661 — deprecation signalling on a `kinds[]` declaration.
 *
 * A kind is marked deprecated with a stated migration window rather than
 * deleted outright. This is authored INSIDE the existing `definition` JSON
 * document (no new column, no migration) — `deprecated: { since, migrateBy?,
 * message? }` — so it rides the SAME publish/validate/discovery path every
 * other declaration does:
 *
 *  - `contextSchemaDefinitionProblems` accepts the new per-kind key and
 *    validates its shape.
 *  - Marking a kind deprecated is NOT a breaking change under
 *    `classifyDefinitionChange` — the kind's substrate (`primitive`,
 *    `phiClass`, `cardinality`, `fields`) is untouched, so old clients keep
 *    working exactly as TASK-661's "additive-only enforcement" requires.
 *  - `getEffectiveBundle` returns the full `definition` verbatim, so the
 *    `deprecated` block is already surfaced to any client reading the
 *    discovery bundle — proven here via `contextSchemaDefinitionProblems` +
 *    `findKind`, and end-to-end in `consultation-context-schema.service.test.ts`'s
 *    sibling suite.
 *  - `validateContextPayload` still ACCEPTS a payload for a deprecated kind
 *    during its window — deprecation is a signal, not an enforcement point.
 */
import { describe, it, expect } from 'vitest';
import { contextSchemaDefinitionProblems, findKind } from '../context-schema-definition';
import { classifyDefinitionChange } from '../definition-diff';

function definitionWithDeprecatedKind(deprecated: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kinds: [
      {
        key: 'legacy_intake',
        label: 'Legacy Intake',
        primitive: 'TEXT',
        phiClass: 'PHI',
        cardinality: 'ONE',
        lifecycle: 'PRE',
        producedBy: ['CLIENT'],
        ...(deprecated !== undefined ? { deprecated } : {}),
      },
    ],
  };
}

describe('deprecation signalling — authored on the kind (TASK-661)', () => {
  it('accepts a kind with no `deprecated` block (the default, unchanged from TASK-658)', () => {
    expect(contextSchemaDefinitionProblems(definitionWithDeprecatedKind(undefined))).toEqual([]);
  });

  it('accepts a well-formed deprecation window', () => {
    const definition = definitionWithDeprecatedKind({
      since: '2026-08-11',
      migrateBy: '2026-11-11',
      message: 'Use `intake` instead; this kind is retired after the migration window.',
    });
    expect(contextSchemaDefinitionProblems(definition)).toEqual([]);
  });

  it('accepts a deprecation with no `migrateBy` (open-ended window) and no `message`', () => {
    expect(contextSchemaDefinitionProblems(definitionWithDeprecatedKind({ since: '2026-08-11' }))).toEqual([]);
  });

  it('rejects a `deprecated` block missing `since`', () => {
    expect(contextSchemaDefinitionProblems(definitionWithDeprecatedKind({ migrateBy: '2026-11-11' })).join(' ')).toMatch(/deprecated.*since/i);
  });

  it('rejects a non-ISO-date `since` / `migrateBy`', () => {
    expect(contextSchemaDefinitionProblems(definitionWithDeprecatedKind({ since: 'yesterday' })).join(' ')).toMatch(/since/i);
    expect(
      contextSchemaDefinitionProblems(definitionWithDeprecatedKind({ since: '2026-08-11', migrateBy: 'soon' })).join(' '),
    ).toMatch(/migrateBy/i);
  });

  it('rejects an unknown key inside `deprecated` (fail-closed, mirrors the rest of the envelope)', () => {
    expect(
      contextSchemaDefinitionProblems(definitionWithDeprecatedKind({ since: '2026-08-11', smuggled: true })).join(' '),
    ).toMatch(/smuggled/);
  });

  it('rejects a `deprecated` that is not an object', () => {
    expect(contextSchemaDefinitionProblems(definitionWithDeprecatedKind('yes' as never)).join(' ')).toMatch(/deprecated/i);
  });

  it('is DISCOVERABLE via `findKind` — the exact seam a discovery-bundle reader would use', () => {
    const definition = definitionWithDeprecatedKind({ since: '2026-08-11', migrateBy: '2026-11-11' });
    const kind = findKind(definition, 'legacy_intake');
    expect(kind?.deprecated).toEqual({ since: '2026-08-11', migrateBy: '2026-11-11' });
  });

  it('marking a kind deprecated is ADDITIVE, never BREAKING — old clients are not forced to acknowledge anything', () => {
    const before = definitionWithDeprecatedKind(undefined);
    const after = definitionWithDeprecatedKind({ since: '2026-08-11', migrateBy: '2026-11-11', message: 'Use `intake` instead.' });
    expect(classifyDefinitionChange(before, after).classification).toBe('ADDITIVE');
  });

  it('REMOVING a deprecation block is also ADDITIVE (un-deprecating relaxes nothing a client relied on)', () => {
    const before = definitionWithDeprecatedKind({ since: '2026-08-11' });
    const after = definitionWithDeprecatedKind(undefined);
    expect(classifyDefinitionChange(before, after).classification).toBe('ADDITIVE');
  });
});

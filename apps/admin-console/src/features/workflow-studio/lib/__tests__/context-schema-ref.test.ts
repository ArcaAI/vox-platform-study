import { describe, expect, it } from 'vitest';
import {
  readContextSchemaBinding,
  withContextSchemaMode,
  withContextSchemaReference,
  withContextSchemaVersion,
} from '../context-schema-ref';

describe('readContextSchemaBinding', () => {
  it('defaults to reference mode with nothing chosen on a fresh node (no contextSchema key at all)', () => {
    expect(readContextSchemaBinding({})).toEqual({ mode: 'reference', schemaId: null, versionNumber: null, inline: null });
  });

  it('reads a reference binding, contextSchemaId present', () => {
    const binding = readContextSchemaBinding({ contextSchema: { contextSchemaId: 'schema-1', versionNumber: 3 } });
    expect(binding).toEqual({ mode: 'reference', schemaId: 'schema-1', versionNumber: 3, inline: null });
  });

  it('reads an inline binding when inline is present and no contextSchemaId', () => {
    const binding = readContextSchemaBinding({ contextSchema: { inline: { type: 'object' } } });
    expect(binding).toEqual({ mode: 'inline', schemaId: null, versionNumber: null, inline: { type: 'object' } });
  });

  it('ignores a non-integer or sub-1 versionNumber', () => {
    expect(readContextSchemaBinding({ contextSchema: { contextSchemaId: 's', versionNumber: 0 } }).versionNumber).toBeNull();
    expect(readContextSchemaBinding({ contextSchema: { contextSchemaId: 's', versionNumber: 1.5 } }).versionNumber).toBeNull();
  });
});

describe('withContextSchemaMode', () => {
  it('switching to reference clears any inline schema', () => {
    const next = withContextSchemaMode({ contextSchema: { inline: { type: 'object' } } }, 'reference');
    expect(readContextSchemaBinding(next)).toEqual({ mode: 'reference', schemaId: null, versionNumber: null, inline: null });
  });

  it('switching to inline clears any reference', () => {
    const next = withContextSchemaMode({ contextSchema: { contextSchemaId: 's', versionNumber: 2 } }, 'inline');
    expect(readContextSchemaBinding(next)).toEqual({ mode: 'inline', schemaId: null, versionNumber: null, inline: {} });
  });

  it('is a no-op when already in the requested mode', () => {
    const config = { contextSchema: { contextSchemaId: 's' }, otherKey: 1 };
    expect(withContextSchemaMode(config, 'reference')).toBe(config);
  });
});

describe('withContextSchemaReference', () => {
  it('binds a schema id with no version pin', () => {
    const next = withContextSchemaReference({}, 'schema-1');
    expect(readContextSchemaBinding(next)).toEqual({ mode: 'reference', schemaId: 'schema-1', versionNumber: null, inline: null });
  });

  it('keeps the existing version pin when re-selecting the SAME schema', () => {
    const config = { contextSchema: { contextSchemaId: 'schema-1', versionNumber: 4 } };
    const next = withContextSchemaReference(config, 'schema-1');
    expect(readContextSchemaBinding(next).versionNumber).toBe(4);
  });

  it('drops the version pin when switching to a DIFFERENT schema — pins are scoped to one lineage', () => {
    const config = { contextSchema: { contextSchemaId: 'schema-1', versionNumber: 4 } };
    const next = withContextSchemaReference(config, 'schema-2');
    expect(readContextSchemaBinding(next)).toEqual({ mode: 'reference', schemaId: 'schema-2', versionNumber: null, inline: null });
  });

  it('clears the binding entirely when passed null', () => {
    const config = { contextSchema: { contextSchemaId: 'schema-1', versionNumber: 4 } };
    expect(readContextSchemaBinding(withContextSchemaReference(config, null)).schemaId).toBeNull();
  });
});

describe('withContextSchemaVersion', () => {
  it('pins a version on the currently-referenced schema', () => {
    const config = { contextSchema: { contextSchemaId: 'schema-1' } };
    expect(readContextSchemaBinding(withContextSchemaVersion(config, 5)).versionNumber).toBe(5);
  });

  it('removes the pin ("follow latest") when passed null', () => {
    const config = { contextSchema: { contextSchemaId: 'schema-1', versionNumber: 5 } };
    expect(readContextSchemaBinding(withContextSchemaVersion(config, null)).versionNumber).toBeNull();
  });

  it('never writes version 0 or a non-integer', () => {
    const config = { contextSchema: { contextSchemaId: 'schema-1' } };
    expect(readContextSchemaBinding(withContextSchemaVersion(config, 0)).versionNumber).toBeNull();
  });
});

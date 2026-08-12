import { describe, expect, it } from 'vitest';
import { CodegenError } from '../errors';
import { jsonSchemaSubsetToTs } from '../schema-to-ts';

describe('jsonSchemaSubsetToTs', () => {
  it('renders primitive types', () => {
    expect(jsonSchemaSubsetToTs({ type: 'string' })).toBe('string');
    expect(jsonSchemaSubsetToTs({ type: 'number' })).toBe('number');
    expect(jsonSchemaSubsetToTs({ type: 'integer' })).toBe('number');
    expect(jsonSchemaSubsetToTs({ type: 'boolean' })).toBe('boolean');
    expect(jsonSchemaSubsetToTs({ type: 'null' })).toBe('null');
  });

  it('renders an array via items', () => {
    expect(jsonSchemaSubsetToTs({ type: 'array', items: { type: 'string' } })).toBe('(string)[]');
  });

  it('renders an array with no items as unknown[]', () => {
    expect(jsonSchemaSubsetToTs({ type: 'array' })).toBe('(unknown)[]');
  });

  it('renders an object with required and optional properties', () => {
    const result = jsonSchemaSubsetToTs({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
    expect(result).toBe('{ a: string; b?: number; }');
  });

  it('quotes a non-identifier property key', () => {
    const result = jsonSchemaSubsetToTs({
      type: 'object',
      properties: { 'weird-key': { type: 'string' } },
    });
    expect(result).toContain('"weird-key"?: string;');
  });

  it('adds an index signature for a typed additionalProperties', () => {
    const result = jsonSchemaSubsetToTs({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    expect(result).toBe('{ a?: string; [key: string]: number; }');
  });

  it('renders a fully open object (no properties, no additionalProperties) as Record<string, unknown>', () => {
    expect(jsonSchemaSubsetToTs({ type: 'object' })).toBe('Record<string, unknown>');
  });

  it('renders a closed empty object (additionalProperties: false, no properties) as Record<string, never>', () => {
    expect(jsonSchemaSubsetToTs({ type: 'object', additionalProperties: false })).toBe('Record<string, never>');
  });

  it('renders a string enum as a union of literals', () => {
    expect(jsonSchemaSubsetToTs({ type: 'string', enum: ['A', 'B'] })).toBe('("A" | "B")');
  });

  it('renders a const as a literal type', () => {
    expect(jsonSchemaSubsetToTs({ const: 'fixed' })).toBe('"fixed"');
    expect(jsonSchemaSubsetToTs({ const: 42 })).toBe('42');
    expect(jsonSchemaSubsetToTs({ const: true })).toBe('true');
    expect(jsonSchemaSubsetToTs({ const: null })).toBe('null');
  });

  it('renders anyOf as a union', () => {
    expect(jsonSchemaSubsetToTs({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('(string | number)');
  });

  it('renders allOf as an intersection', () => {
    const result = jsonSchemaSubsetToTs({
      allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }],
    });
    expect(result).toBe('({ a: string; } & { b: number; })');
  });

  it('renders a discriminated oneOf as a union, one member per branch', () => {
    const result = jsonSchemaSubsetToTs({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' }, x: { type: 'string' } }, required: ['kind', 'x'] },
        { type: 'object', properties: { kind: { const: 'b' }, y: { type: 'number' } }, required: ['kind', 'y'] },
      ],
      discriminator: { propertyName: 'kind' },
    });
    expect(result).toBe('({ kind: "a"; x: string; } | { kind: "b"; y: number; })');
  });

  it('renders an empty schema ({}) as unknown', () => {
    expect(jsonSchemaSubsetToTs({})).toBe('unknown');
  });

  describe('fail loudly (TDD-3: unsupported/unknown constructs never emit a wrong type)', () => {
    it('throws on if/then/else at the root', () => {
      expect(() => jsonSchemaSubsetToTs({ if: { const: 'x' }, then: { type: 'string' } })).toThrow(CodegenError);
    });

    it('throws on if/then/else nested inside a property', () => {
      expect(() =>
        jsonSchemaSubsetToTs({
          type: 'object',
          properties: { a: { if: { const: 'x' }, then: { type: 'string' }, else: { type: 'number' } } },
        }),
      ).toThrow(CodegenError);
    });

    it('throws on oneOf without a sibling discriminator', () => {
      expect(() =>
        jsonSchemaSubsetToTs({
          oneOf: [{ type: 'string' }, { type: 'number' }],
        }),
      ).toThrow(/discriminator/);
    });

    it('throws on oneOf whose discriminator has no propertyName', () => {
      expect(() =>
        jsonSchemaSubsetToTs({
          oneOf: [{ type: 'string' }],
          discriminator: {},
        }),
      ).toThrow(CodegenError);
    });

    it('throws on an unrecognized type value', () => {
      expect(() => jsonSchemaSubsetToTs({ type: 'date-time' })).toThrow(/unsupported JSON Schema 'type'/);
    });

    it('throws when the schema node itself is not a plain object', () => {
      expect(() => jsonSchemaSubsetToTs('not-a-schema')).toThrow(CodegenError);
      expect(() => jsonSchemaSubsetToTs(null)).toThrow(CodegenError);
      expect(() => jsonSchemaSubsetToTs(['array', 'is', 'not', 'a', 'schema'])).toThrow(CodegenError);
    });

    it('error messages include the failing path', () => {
      try {
        jsonSchemaSubsetToTs(
          { type: 'object', properties: { nested: { type: 'weird' } } },
          { path: 'kinds.example.fields' },
        );
        expect.unreachable('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(CodegenError);
        expect((error as Error).message).toContain('kinds.example.fields.properties.nested');
      }
    });
  });
});

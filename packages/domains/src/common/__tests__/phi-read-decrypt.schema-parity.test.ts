import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHI_CIPHERTEXT_FIELDS, PHI_MODEL_CIPHERTEXT, PHI_MODEL_RELATIONS } from '../phi-read-decrypt';

/**
 * Drift guard: the model-scoped maps in `phi-read-decrypt.ts` are derived from
 * the Prisma schema. Re-derive them here and fail if the schema moved on — a
 * missing entry silently stops decrypting (visible), a stale one would widen the
 * decrypt surface (dangerous), and both must be caught.
 */

const SCHEMA_DIR = join(__dirname, '../../../../database/src/prisma/db_main');
const lc = (s: string): string => s[0].toLowerCase() + s.slice(1);

function parseModels(): Record<string, string> {
  const models: Record<string, string> = {};
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
    const text = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) models[m[1]] = m[2];
  }
  return models;
}

describe('phi-read-decrypt maps vs Prisma schema', () => {
  const models = parseModels();
  const names = new Set(Object.keys(models));
  const registered = new Set(Object.keys(PHI_CIPHERTEXT_FIELDS));

  it('has a schema-accurate ciphertext column map', () => {
    const expected: Record<string, string[]> = {};
    for (const [name, body] of Object.entries(models)) {
      const cols = [...new Set(body.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => registered.has(c)))].sort();
      if (cols.length) expected[lc(name)] = cols;
    }
    const actual = Object.fromEntries(Object.entries(PHI_MODEL_CIPHERTEXT).map(([k, v]) => [k, [...v].sort()]));
    expect(actual).toEqual(expected);
  });

  it('has a schema-accurate relation map covering every path to a PHI model', () => {
    const relations: Record<string, Record<string, string>> = {};
    for (const [name, body] of Object.entries(models)) {
      const edges: Record<string, string> = {};
      for (const line of body.split('\n')) {
        const m = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line.trim());
        if (m && names.has(m[2])) edges[m[1]] = m[2];
      }
      relations[name] = edges;
    }
    const reach = new Set(Object.keys(PHI_MODEL_CIPHERTEXT).map((k) => k[0].toUpperCase() + k.slice(1)));
    for (let changed = true; changed; ) {
      changed = false;
      for (const [parent, edges] of Object.entries(relations)) {
        for (const child of Object.values(edges)) {
          if (reach.has(child) && !reach.has(parent)) {
            reach.add(parent);
            changed = true;
          }
        }
      }
    }
    const expected: Record<string, Record<string, string>> = {};
    for (const [parent, edges] of Object.entries(relations)) {
      const kept: Record<string, string> = {};
      for (const [field, child] of Object.entries(edges)) if (reach.has(child)) kept[field] = lc(child);
      if (Object.keys(kept).length) expected[lc(parent)] = kept;
    }
    expect(PHI_MODEL_RELATIONS).toEqual(expected);
  });

  it('never treats an opaque JSON payload column as traversable', () => {
    // AuditLog holds entity snapshots; it must have neither ciphertext columns
    // nor relation edges in these maps.
    expect(PHI_MODEL_CIPHERTEXT.auditLog).toBeUndefined();
    expect(PHI_MODEL_RELATIONS.auditLog).toBeUndefined();
  });
});

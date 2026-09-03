import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_TAGS, API_TAGS_BY_NAME, planeForTag } from '../tags';

/**
 * the tag taxonomy is a CLOSED SET.
 *
 * Tags are the only grouping an OpenAPI renderer has, so an undeclared tag is
 * a section of the developer reference that nobody wrote a description for. It
 * appears at the bottom of the sidebar as a bare slug and reads as an
 * oversight, because it is one.
 *
 * The scan below reads the controller SOURCES rather than `openapi.json`
 * deliberately: it fails the moment a `@ApiTags('…')` is added, without
 * waiting for someone to re-run `pnpm api:openapi`.
 */

const SRC_ROOT = resolve(__dirname, '..', '..');

/** Every `@ApiTags('a', 'b')` argument list in the app's TypeScript sources. */
function collectApiTagsFromSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;

      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/@ApiTags\(([^)]*)\)/g)) {
        for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
          const tag = literal[1];
          const files = found.get(tag) ?? [];
          if (!files.includes(full)) files.push(full);
          found.set(tag, files);
        }
      }
    }
  };

  walk(SRC_ROOT);
  return found;
}

describe('API tag taxonomy', () => {
  const usedInSource = collectApiTagsFromSource();

  it('finds tags to check (guards against a silently broken scan)', () => {
    // A regex scan that matches nothing would make every assertion below
    // vacuously pass — the exact failure mode of the test this replaced.
    expect(usedInSource.size).toBeGreaterThan(50);
  });

  it('declares every tag used by a controller', () => {
    const undeclared = [...usedInSource.entries()]
      .filter(([tag]) => !API_TAGS_BY_NAME.has(tag))
      .map(([tag, files]) => `${tag} (used in ${files.map((f) => f.replace(`${SRC_ROOT}/`, '')).join(', ')})`);

    expect(undeclared).toEqual([]);
  });

  it('has no duplicate names', () => {
    expect(API_TAGS.length).toBe(API_TAGS_BY_NAME.size);
  });

  it('gives every tag a non-empty description and display name', () => {
    const incomplete = API_TAGS.filter((tag) => !tag.description.trim() || !tag.displayName.trim()).map((tag) => tag.name);

    expect(incomplete).toEqual([]);
  });

  it('groups tags by plane — business, then admin, then platform', () => {
    const planeOrder = ['business', 'admin', 'platform'];
    const seen = API_TAGS.map((tag) => planeOrder.indexOf(tag.plane));

    expect(seen).not.toContain(-1);
    // Order here is the renderer's sidebar order, so the groups must be contiguous.
    expect([...seen]).toEqual([...seen].sort((a, b) => a - b));
  });

  it('marks every admin-* tag as the admin plane', () => {
    const misfiled = API_TAGS.filter((tag) => tag.name.startsWith('admin-') && tag.plane !== 'admin').map((tag) => tag.name);

    expect(misfiled).toEqual([]);
  });

  it('resolves a plane for a declared tag and undefined for an unknown one', () => {
    expect(planeForTag('consultations')).toBe('business');
    expect(planeForTag('admin-users')).toBe('admin');
    expect(planeForTag('definitely-not-a-tag')).toBeUndefined();
  });
});

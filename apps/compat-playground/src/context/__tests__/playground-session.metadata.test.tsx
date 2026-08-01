import { describe, expect, it } from 'vitest';
import { buildRowMetadata, type MetadataMicRow } from '../playground-session';

// Pure-function coverage for the per-mic-row metadata guard (TASK-597 lane C,
// R5 requirement 4) — no React needed. `.tsx` extension only because the app's
// vitest config collects `src/**/*.test.tsx` exclusively (see vitest.config.ts).

function row(overrides: Partial<MetadataMicRow> = {}): MetadataMicRow {
  return { id: 'mic-1', mic: '1', speaker: '1', json: '{}', ...overrides };
}

describe('buildRowMetadata', () => {
  it('merges mic/speaker with the free-form JSON object', () => {
    const result = buildRowMetadata(row({ json: '{"note":"left channel"}' }));
    expect(result).toEqual({ metadata: { note: 'left channel', mic: '1', speaker: '1' } });
  });

  it('omits blank mic/speaker fields rather than sending empty strings', () => {
    const result = buildRowMetadata(row({ mic: '', speaker: '  ' }));
    expect(result).toEqual({ metadata: {} });
  });

  it('rejects invalid JSON with a parse error, not a throw', () => {
    const result = buildRowMetadata(row({ json: '{not valid' }));
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/Invalid metadata JSON/);
  });

  it('rejects a non-object JSON value (array/primitive)', () => {
    expect(buildRowMetadata(row({ json: '[1,2,3]' }))).toEqual({ error: 'metadata JSON must be an object' });
    expect(buildRowMetadata(row({ json: '"just a string"' }))).toEqual({ error: 'metadata JSON must be an object' });
  });

  it('accepts a payload right at the 8192-byte boundary', () => {
    // {"mic":"1","speaker":"1","blob":"...."} — pad `blob` so the whole
    // stringified object lands exactly at MAX_METADATA_BYTES.
    const prefix = '{"blob":"';
    const suffix = '","mic":"1","speaker":"1"}';
    const padLength = 8192 - (prefix.length + suffix.length);
    const json = `${prefix}${'x'.repeat(padLength)}${suffix}`;
    const result = buildRowMetadata(row({ json }));
    expect(result).not.toHaveProperty('error');
    expect(JSON.stringify((result as { metadata: Record<string, unknown> }).metadata).length).toBe(8192);
  });

  it('rejects a payload one byte past the 8192-byte guard with a field-error message, not a throw', () => {
    const json = `{"blob":"${'x'.repeat(9000)}"}`;
    const result = buildRowMetadata(row({ json }));
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/exceeds 8192 bytes/);
  });
});

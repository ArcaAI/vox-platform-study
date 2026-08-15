import { describe, expect, it } from 'vitest';
import {
  CONNECTION_EXAMPLE_FILES,
  LIVE_TRANSCRIPTION_EXAMPLE_FILES,
  SUMMARIZATION_EXAMPLE_FILES,
  loadExampleSource,
  type ExampleFile,
} from '../TabExampleCode';

/**
 * The guard the mechanism needs.
 *
 * `import.meta.glob` is analysed STATICALLY by Vite: only the literal paths in
 * the glob array get a loader. A path listed on a tab but missing from that
 * array yields no loader at all — which, before this test existed, rendered as
 * a silently EMPTY code block that looks exactly like a normal collapsed one.
 *
 * So: load every file of every tab and assert it has real content. A typo, a
 * renamed component, or a forgotten glob entry fails here instead of shipping
 * an empty "example".
 */

const TABS: Array<[string, ExampleFile[]]> = [
  ['Connection', CONNECTION_EXAMPLE_FILES],
  ['Live transcription', LIVE_TRANSCRIPTION_EXAMPLE_FILES],
  ['Summarization', SUMMARIZATION_EXAMPLE_FILES],
];

describe('TabExampleCode source registry', () => {
  it.each(TABS)('%s lists at least one file', (_name, files) => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(TABS.flatMap(([tab, files]) => files.map((file) => [tab, file] as const)))('%s → %s loads non-empty source', async (_tab, file) => {
    const source = await loadExampleSource(file.path);
    expect(typeof source).toBe('string');
    // A real source file, not a stub and not an empty glob miss. The shortest
    // file in the registry is comfortably over this.
    expect(source.trim().length).toBeGreaterThan(200);
  });

  it('rejects a path that is not in the glob array instead of resolving to an empty string', async () => {
    await expect(loadExampleSource('/src/components/NotAFile.tsx')).rejects.toThrow(/import\.meta\.glob/);
  });

  it('has no duplicate paths within a tab', () => {
    for (const [, files] of TABS) {
      const paths = files.map((f) => f.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it('titles every file and labels the language from its extension', () => {
    for (const [, files] of TABS) {
      for (const file of files) {
        expect(file.title.trim()).not.toBe('');
        expect(file.language).toBe(file.path.endsWith('.tsx') ? 'tsx' : 'ts');
      }
    }
  });
});

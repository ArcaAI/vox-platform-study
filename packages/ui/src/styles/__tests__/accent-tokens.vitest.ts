import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs each package's suite with cwd = the package root.
const css = readFileSync(join(process.cwd(), 'src/styles/globals.css'), 'utf8');

describe('accent token layer (TASK-437)', () => {
  it('teal is the attribute-less default (no data-accent="teal" block)', () => {
    expect(css).not.toContain('[data-accent="teal"]');
    // Base :root keeps the teal primary.
    expect(css).toMatch(/:root\s*{[\s\S]*--primary:\s*var\(--teal-600\)/);
  });

  it.each(['indigo', 'green', 'amber'])('defines a light and a dark block for the %s accent', (accent) => {
    expect(css).toContain(`:root[data-accent="${accent}"]`);
    expect(css).toContain(`.dark[data-accent="${accent}"]`);
  });

  it('remaps the accent-derived semantic tokens in each block', () => {
    const block = /:root\[data-accent="indigo"\]\s*{([\s\S]*?)}/.exec(css)?.[1] ?? '';
    for (const token of ['--primary', '--accent', '--ring', '--sidebar-primary', '--chart-1']) {
      expect(block).toContain(token);
    }
    // The indigo accent draws from the indigo ramp.
    expect(block).toContain('var(--indigo-600)');
  });
});

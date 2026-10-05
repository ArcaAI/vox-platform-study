import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CITATION_LABEL_PATTERN, citationLabelsOf, stripCitationLabels } from '../../packages/types/src/citation-labels';

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, './citation-labels.fixture.json'), 'utf8'),
) as {
  label: { pattern: string };
  cases: { name: string; input: string; stripped: string; labels: string[] }[];
};

describe('citation labels (fixture parity)', () => {
  it('uses the fixture pattern verbatim', () => {
    expect(CITATION_LABEL_PATTERN).toBe(fixture.label.pattern);
  });

  it('is not vacuous', () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(stripCitationLabels(c.input)).toBe(c.stripped);
    expect(citationLabelsOf(c.input)).toEqual(c.labels);
  });
});

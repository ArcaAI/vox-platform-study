import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CITATION_LABEL_PATTERN, NOTE_READY_REASON, citationLabelsOf, isNoteReady, stripCitationLabels } from '../index';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../tests/contracts/citation-labels.fixture.json'), 'utf8'),
) as { label: { pattern: string }; cases: { name: string; input: string; stripped: string; labels: string[] }[] };

describe('citation labels (fixture parity)', () => {
  it('uses the fixture pattern verbatim', () => {
    expect(CITATION_LABEL_PATTERN).toBe(fixture.label.pattern);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(stripCitationLabels(c.input)).toBe(c.stripped);
    expect(citationLabelsOf(c.input)).toEqual(c.labels);
  });
});

describe('isNoteReady', () => {
  it('is true for STOPPED + IDLE + NOTE_READY and STOPPED + AWAITING_REVIEW only', () => {
    expect(NOTE_READY_REASON).toBe('NOTE_READY');
    expect(isNoteReady({ status: 'STOPPED', processing: 'IDLE', processingReason: 'NOTE_READY' })).toBe(true);
    expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW' })).toBe(true);
    expect(isNoteReady({ status: 'STOPPED', processing: 'IDLE' })).toBe(false);
    expect(isNoteReady({ status: 'STOPPED', processing: 'SUMMARIZING', processingReason: 'NOTE_READY' })).toBe(false);
    expect(isNoteReady({ status: 'APPROVED', processing: 'IDLE', processingReason: 'NOTE_READY' })).toBe(false);
  });
});

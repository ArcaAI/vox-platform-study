/**
 * TASK-890 black-box J4-F7 — the palette keys a new definition may target.
 *
 * `Palette key *` was a free-text box: a typo produced a definition targeting a palette that does
 * not exist, and nothing in the form said which ones do. The set is code-owned (the node
 * registry), so it is derivable — `core` first (the one authoring vocabulary, TASK-864), the rest
 * alphabetical, and a palette whose every node type is deprecated is marked rather than silently
 * offered as an equal choice.
 */
import { describe, expect, it } from 'vitest';
import { paletteKeyOptions } from '../palette-keys';
import type { WorkflowNodeDescriptor } from '../../api/types';

function descriptor(type: string, paletteKey: string | null, deprecated = false): WorkflowNodeDescriptor {
  return {
    type,
    implemented: true,
    activityName: `interpreter.${type}`,
    classes: [],
    paletteKey,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    configSchema: null,
    inputs: [],
    outputs: [],
    deprecated,
  };
}

describe('paletteKeyOptions', () => {
  it('lists every registered palette, core first, then alphabetically', () => {
    const options = paletteKeyOptions([
      descriptor('summarize', 'summarization'),
      descriptor('core.agent', 'core'),
      descriptor('ingest', 'stt'),
    ]);
    expect(options.map((option) => option.key)).toEqual(['core', 'stt', 'summarization']);
  });

  it('marks a palette whose every node type is deprecated, and never a palette that still has one', () => {
    const options = paletteKeyOptions([
      descriptor('legacy.a', 'legacy', true),
      descriptor('legacy.b', 'legacy', true),
      descriptor('summarize', 'summarization', true),
      descriptor('deliver', 'summarization'),
    ]);
    expect(options).toEqual([
      { key: 'legacy', deprecated: true },
      { key: 'summarization', deprecated: false },
    ]);
  });

  it('ignores palette-agnostic utility types — they belong to no palette a definition can target', () => {
    expect(paletteKeyOptions([descriptor('core.start', null)])).toEqual([]);
    expect(paletteKeyOptions([])).toEqual([]);
  });
});

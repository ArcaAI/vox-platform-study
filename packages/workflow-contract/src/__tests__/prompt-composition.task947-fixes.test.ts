/**
 * TASK-947 — reviewer findings on the composer (R1 #4/#5).
 *
 * `c3aeb87b8` closed ONE malformed shape (no `fragments` list). Six siblings remained where the
 * TypeScript composer threw a bare `TypeError` and the Python mirror composed: a non-object list
 * entry, a fragment with a missing or `null` `content`, and a single-body artifact with a missing
 * or `null` `content`. Publish cannot produce any of them — but "refuse by name or compose" is
 * the parity property, and a `TypeError` is neither. A non-string fragment KEY is coerced to a
 * string so `selected` honours its `readonly string[]` type all the way into telemetry.
 */
import { describe, expect, it } from 'vitest';
import { composePrompt, type CompositeResolvedPrompt } from '../prompt-composition';

const scope = { vars: { tone: 'concise' } };

describe('composePrompt — malformed shapes compose or refuse by NAME, never a TypeError', () => {
  it('skips a non-object list entry', () => {
    const artifact = {
      source: 'composite',
      content: 'A',
      join: '\n\n',
      fragments: [null, { key: 'a', source: 'inline', content: 'A', when: null }, 'junk'],
    } as unknown as CompositeResolvedPrompt;
    expect(composePrompt(artifact, scope)).toEqual({ prompt: 'A', selected: ['a'], excluded: [] });
  });

  it('renders a fragment with a missing or `null` content as the empty string', () => {
    const artifact = {
      source: 'composite',
      content: '',
      join: '|',
      fragments: [
        { key: 'a', source: 'inline', when: null },
        { key: 'b', source: 'inline', content: null, when: null },
        { key: 'c', source: 'inline', content: 'C', when: null },
      ],
    } as unknown as CompositeResolvedPrompt;
    expect(composePrompt(artifact, scope)).toEqual({ prompt: '||C', selected: ['a', 'b', 'c'], excluded: [] });
  });

  it('renders a single-body artifact with a missing or `null` content as the empty string', () => {
    expect(composePrompt({ source: 'inline' } as never, scope).prompt).toBe('');
    expect(composePrompt({ source: 'inline', content: null } as never, scope).prompt).toBe('');
    expect(composePrompt({ source: 'template', promptTemplateId: 't', promptVersionNumber: 1 } as never, scope).prompt).toBe('');
  });

  it('coerces a non-string fragment key to a string in `selected` and `excluded`', () => {
    const artifact = {
      source: 'composite',
      content: '',
      join: '\n\n',
      fragments: [
        { key: 7, source: 'inline', content: 'A', when: null },
        { key: null, source: 'inline', content: 'B', when: 'false' },
      ],
    } as unknown as CompositeResolvedPrompt;
    const result = composePrompt(artifact, scope);
    expect(result.selected).toEqual(['7']);
    expect(result.excluded.map((entry) => entry.key)).toEqual(['null']);
  });
});

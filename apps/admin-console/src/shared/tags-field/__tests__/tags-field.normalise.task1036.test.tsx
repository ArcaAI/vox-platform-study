/**
 * TASK-1036 C6 (Q16) — the field normalises to trimmed lower-case BEFORE validating, as the
 * server does, so `Pre-Summary` becomes `pre-summary` instead of being refused. The grammar
 * still applies to what is left.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TagsField } from '../tags-field';
import { normalizeTag } from '../tag-grammar';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function Harness({ onChange, initial = [] }: { onChange: (next: string[]) => void; initial?: string[] }) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <TagsField
      id="t"
      value={tags}
      onChange={(next) => {
        setTags(next);
        onChange(next);
      }}
    />
  );
}
const input = () => screen.getByRole('combobox', { name: /tags/i }) as HTMLInputElement;

describe('normalizeTag', () => {
  it('trims and lower-cases', () => {
    expect(normalizeTag('  Pre-Summary ')).toBe('pre-summary');
    expect(normalizeTag('Dept:Cardiology')).toBe('dept:cardiology');
  });
});

describe('TagsField normalisation', () => {
  it('adds `Pre-Summary` as `pre-summary` with no error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    fireEvent.change(input(), { target: { value: 'Pre-Summary' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['pre-summary']));
    expect(input().value).toBe('');
  });

  it('treats `SOAP` as a duplicate of an existing `soap`', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={['soap']} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'SOAP' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('normalises each part of a comma-separated paste', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'A-Tag,Dept:Renal' } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['a-tag', 'dept:renal']));
  });

  it('still refuses what the grammar rejects after normalising', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'Bad Tag' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/lower-case/i);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

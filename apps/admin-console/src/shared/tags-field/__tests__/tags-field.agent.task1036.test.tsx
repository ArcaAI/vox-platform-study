/**
 * TASK-1036 C5 — `TagsField` fed by `GET admin/agents/tags`, validating the AGENT grammar
 * (`key:value` only — a bare tag is a 400 on the agent routes).
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TagsField } from '../tags-field';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function Harness() {
  const [tags, setTags] = useState<string[]>([]);
  return (
    <TagsField
      id="agent-tags"
      value={tags}
      onChange={setTags}
      suggestionsPath="admin/agents/tags"
      validate={(tag) => (tag.includes(':') ? null : `"${tag}" must be key:value`)}
    />
  );
}

describe('TagsField with a custom suggestions path and grammar', () => {
  it('reads suggestions from the agents tag route, not the prompt route', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json([{ tag: 'dept:cardiology', count: 2 }]));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<Harness />);
    fireEvent.focus(screen.getByRole('combobox', { name: /tags/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('admin/agents/tags'))).toBe(true);
    expect(urls.some((url) => url.includes('admin/prompt-templates/tags'))).toBe(false);
    expect(await screen.findByText('dept:cardiology')).toBeTruthy();
  });

  it('refuses a bare tag with the injected grammar message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    renderWithProviders(<Harness />);
    const input = screen.getByRole('combobox', { name: /tags/i });
    fireEvent.change(input, { target: { value: 'bare' } });
    expect(await screen.findByText(/must be key:value/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('list', { name: /tags added/i })).toBeNull();
  });
});

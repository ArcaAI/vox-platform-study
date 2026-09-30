/** TASK-1023 — the shared bucket path picker: browse folders, breadcrumbs, pick a folder or a file. */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { BucketPathPicker } from '../bucket-path-picker';
import { deriveEntries, sortEntries } from '../entries';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OBJECTS = [
  { key: 'whisper/f16-abc/ggml-model.bin', size: 1000 },
  { key: 'whisper/f16-abc/config.json', size: 10 },
  { key: 'gemma/q4/model.gguf', size: 500 },
  { key: 'readme.txt', size: 5 },
];

function stubListing(objects = OBJECTS) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json(objects);
    }),
  );
  return urls;
}

describe('deriveEntries / sortEntries', () => {
  it('groups keys into folders and files under a prefix, folders first', () => {
    const root = sortEntries(deriveEntries(OBJECTS, ''), 'key:asc');
    expect(root.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['folder:gemma', 'folder:whisper', 'file:readme.txt']);
    const inner = deriveEntries(OBJECTS.filter((object) => object.key.startsWith('whisper/f16-abc/')), 'whisper/f16-abc/');
    expect(inner.map((entry) => entry.name).sort()).toEqual(['config.json', 'ggml-model.bin']);
  });
});

describe('BucketPathPicker', () => {
  it('lists the bucket root through the files route and opens a folder', async () => {
    const urls = stubListing();
    renderWithProviders(<BucketPathPicker bucket="hope-models" value="" onChange={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Open folder whisper' })).toBeDefined();
    expect(urls[0]).toContain('storage/buckets/hope-models/files');

    fireEvent.click(screen.getByRole('button', { name: 'Open folder whisper' }));
    expect(await screen.findByRole('button', { name: 'Open folder f16-abc' })).toBeDefined();
    // The breadcrumb tracks the prefix and navigates back.
    expect(screen.getByRole('button', { name: 'whisper' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'hope-models' }));
    expect(await screen.findByRole('button', { name: 'Open folder gemma' })).toBeDefined();
  });

  it('selects a folder as a prefix with a trailing slash', async () => {
    stubListing();
    const onChange = vi.fn();
    renderWithProviders(<BucketPathPicker bucket="hope-models" value="" onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select folder gemma' }));
    expect(onChange).toHaveBeenCalledWith('gemma/');
  });

  it('selects a file by its full key', async () => {
    stubListing();
    const onChange = vi.fn();
    renderWithProviders(<BucketPathPicker bucket="hope-models" value="" onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder gemma' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder q4' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select file model.gguf' }));
    expect(onChange).toHaveBeenCalledWith('gemma/q4/model.gguf');
  });

  it('marks the selected entry and has no axe violations', async () => {
    stubListing();
    const { container } = renderWithProviders(<BucketPathPicker bucket="hope-models" value="gemma/" onChange={() => {}} />);
    const selected = await screen.findByRole('button', { name: 'Select folder gemma' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    await waitFor(async () => expect((await axe(container)).violations).toHaveLength(0));
  });
});

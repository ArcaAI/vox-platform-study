/**
 * "In bucket, not registered" drawer: renders every layout the inventory can
 * report — `flat` / `hf-cache` (manifest-bearing, written by the publish job)
 * and `staged` (an admin upload with no `manifest.json`, TASK-960 Lane C). A
 * `staged` entry commonly carries neither `slug` nor `version` — this must
 * render legibly (no empty gaps, no literal "null"/"undefined") and be
 * visually distinguishable from the manifest-bearing layouts.
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ModelInventoryReport, UnregisteredBucketPrefix } from '../../api/types';
import { UnregisteredPrefixesDrawer } from '../unregistered-prefixes-drawer';

afterEach(() => {
  cleanup();
});

const FLAT: UnregisteredBucketPrefix = {
  bucketPrefix: 'whisper-large-v4/q4-0-451faffb5a16/',
  layout: 'flat',
  slug: 'whisper-large-v4',
  version: 'q4-0-451faffb5a16',
  objectCount: 3,
  totalBytes: 1_500_000,
};

const HF_CACHE: UnregisteredBucketPrefix = {
  bucketPrefix: 'hf/hub/models--openai--whisper-large-v4/snapshots/abc123/',
  layout: 'hf-cache',
  slug: null,
  version: null,
  objectCount: 5,
  totalBytes: null,
};

/** The common shape: no manifest, so no version, and often no inferred slug either. */
const STAGED: UnregisteredBucketPrefix = {
  bucketPrefix: 'arcaai-whisper-en-2609/',
  layout: 'staged',
  slug: null,
  version: null,
  objectCount: 2,
  totalBytes: 1_620_000_000,
};

function reportWith(unregistered: UnregisteredBucketPrefix[]): ModelInventoryReport {
  return {
    checkedAt: '2026-09-12T00:00:00.000Z',
    counts: { available: 0, missing: 0, partial: 0, notApplicable: 0 },
    rows: [],
    unregistered,
  };
}

describe('UnregisteredPrefixesDrawer — layouts', () => {
  it('labels flat and hf-cache with an outline badge, and renders their slug + version', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([FLAT])} onRegister={() => {}} />);

    expect(screen.getByText('Flat')).toBeDefined();
    expect(screen.getByText('whisper-large-v4')).toBeDefined();
    expect(screen.getByText('vq4-0-451faffb5a16')).toBeDefined();
  });

  it('labels a manifest-less admin upload "Staged upload" with a distinct (secondary) badge and an explanatory caption', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([STAGED])} onRegister={() => {}} />);

    const badge = screen.getByText('Staged upload');
    expect(badge).toBeDefined();
    expect(badge.getAttribute('data-variant')).toBe('secondary');
    expect(screen.getByText(/no manifest\.json/i)).toBeDefined();
  });

  it('never renders a staged badge for flat/hf-cache, and never renders the staged caption for them', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([FLAT, HF_CACHE])} onRegister={() => {}} />);

    expect(screen.queryByText('Staged upload')).toBeNull();
    expect(screen.queryByText(/no manifest\.json/i)).toBeNull();
    const flatBadge = screen.getByText('Flat');
    expect(flatBadge.getAttribute('data-variant')).toBe('outline');
  });

  it('renders a staged entry with no slug and no version legibly — no empty gaps, no literal null/undefined', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([STAGED])} onRegister={() => {}} />);

    expect(screen.getByText('arcaai-whisper-en-2609/')).toBeDefined();
    expect(screen.getByText(/2 objects/)).toBeDefined();
    expect(screen.queryByText(/null/i)).toBeNull();
    expect(screen.queryByText(/undefined/i)).toBeNull();
    // No stray "v" left behind from a version span that would otherwise render empty.
    expect(screen.queryByText(/^v$/)).toBeNull();
  });

  it('still calls onRegister with the full item, including for a staged (slug-less) prefix', () => {
    const onRegister = vi.fn();
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([STAGED])} onRegister={onRegister} />);

    fireEvent.click(screen.getByRole('button', { name: /register arcaai-whisper-en-2609/i }));
    expect(onRegister).toHaveBeenCalledWith(STAGED);
  });

  it('renders every layout side by side without one clobbering another', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([FLAT, HF_CACHE, STAGED])} onRegister={() => {}} />);

    const list = screen.getByRole('list', { name: /unregistered bucket prefixes/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Flat')).toBeDefined();
    expect(within(list).getByText('HF cache')).toBeDefined();
    expect(within(list).getByText('Staged upload')).toBeDefined();
  });
});

describe('UnregisteredPrefixesDrawer — states', () => {
  it('shows the no-inventory empty state when no report has run yet', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={null} onRegister={() => {}} />);
    expect(screen.getByText('No inventory yet')).toBeDefined();
  });

  it('shows the all-registered empty state when the report found nothing unregistered', () => {
    renderWithProviders(<UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([])} onRegister={() => {}} />);
    expect(screen.getByText('Every prefix in the bucket is registered')).toBeDefined();
  });
});

describe('UnregisteredPrefixesDrawer accessibility', () => {
  it('has no axe violations with flat, hf-cache and staged entries all rendered', async () => {
    const { container } = renderWithProviders(
      <UnregisteredPrefixesDrawer open onOpenChange={() => {}} report={reportWith([FLAT, HF_CACHE, STAGED])} onRegister={() => {}} />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
    expect(container).toBeDefined();
  });
});

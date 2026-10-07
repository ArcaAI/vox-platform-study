/**
 * TASK-1051 lane C1 — the "Needs attention" strip (artboard 01): risk-ordered,
 * a text tag on every row (never colour alone), one call to action each,
 * hidden when empty.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AttentionStrip } from '../attention-strip';
import { deriveAttentionItems } from '../residency-display';
import { GiB, LIVE_WHISPER, LMS, makeCatalogue, makeDevice, makeService, PINNED_NOT_LOADED, STT, UNMATCHED_GEMMA } from './residency-test-data';

afterEach(cleanup);

const OVER = makeDevice({ overHeadroom: true, freeBytes: 26 * 1024 ** 2, headroomBytes: 2.4 * GiB, unattributedBytes: 5.8 * GiB });
const ITEMS = deriveAttentionItems(makeCatalogue({ devices: [OVER], services: [STT, LMS] }));

describe('AttentionStrip', () => {
  it('renders nothing when no item needs attention', () => {
    const { container } = render(<AttentionStrip items={[]} onLink={vi.fn()} onLoad={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('counts the items in its heading and keeps the risk order with a text tag on each row', () => {
    render(<AttentionStrip items={ITEMS} onLink={vi.fn()} onLoad={vi.fn()} />);
    const section = screen.getByRole('region', { name: /Needs attention/ });
    expect(within(section).getByRole('heading', { name: 'Needs attention (3)' })).toBeDefined();
    const rows = within(section).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByTestId('attention-tag').textContent)).toEqual(['Critical', 'Mismatch', 'Live path']);
  });

  it('links the GPU row to its card, opens Link for a mismatch and Load for a pinned model', () => {
    const onLink = vi.fn();
    const onLoad = vi.fn();
    render(<AttentionStrip items={ITEMS} onLink={onLink} onLoad={onLoad} />);

    const gpuLink = screen.getByRole('link', { name: 'See what is on GPU 0' });
    expect(gpuLink.getAttribute('href')).toBe('#residency-gpu-gpu0');

    fireEvent.click(screen.getByRole('button', { name: 'Link to catalogue…' }));
    expect(onLink).toHaveBeenCalledWith(LMS, UNMATCHED_GEMMA);

    fireEvent.click(screen.getByRole('button', { name: 'Load…' }));
    expect(onLoad).toHaveBeenCalledWith(STT, PINNED_NOT_LOADED);
  });

  it('the GPU link moves focus to the card', () => {
    const card = document.createElement('div');
    card.id = 'residency-gpu-gpu0';
    card.tabIndex = -1;
    document.body.append(card);
    render(<AttentionStrip items={ITEMS} onLink={vi.fn()} onLoad={vi.fn()} />);
    fireEvent.click(screen.getByRole('link', { name: 'See what is on GPU 0' }));
    expect(document.activeElement).toBe(card);
    card.remove();
  });

  it('offers no Load button when the service has no control API', () => {
    const readOnly = makeService({ controllable: false, models: [PINNED_NOT_LOADED, LIVE_WHISPER] });
    render(<AttentionStrip items={deriveAttentionItems(makeCatalogue({ services: [readOnly] }))} onLink={vi.fn()} onLoad={vi.fn()} />);
    expect(screen.getByText('Whisper Large Code-Switch is pinned but not loaded')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load…' })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<AttentionStrip items={ITEMS} onLink={vi.fn()} onLoad={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

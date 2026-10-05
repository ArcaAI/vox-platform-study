import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { HistoryTimelineList } from '../../timeline/history-timeline-list';
import type { TimelineBandModel, TimelineItemModel } from '../../timeline/types';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  for (const [prop, value] of [
    ['clientHeight', 600],
    ['clientWidth', 800],
    ['offsetHeight', 600],
    ['offsetWidth', 800],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

const item = (id: string, title: string, ts: string): TimelineItemModel => ({
  id,
  title,
  timestamp: ts,
  variant: 'markdown',
  content: { type: 'markdown', markdown: title },
});

const oldestFirst = [item('a', 'Alpha', '2026-01-01T10:00:00Z'), item('b', 'Beta', '2026-01-01T11:00:00Z'), item('c', 'Gamma', '2026-01-01T12:00:00Z')];

const titles = () => screen.getAllByRole('article').map((el) => el.querySelector('[id$="-title"]')?.textContent);

describe('HistoryTimelineList — ordering', () => {
  it('inputOrder="asc" renders the given oldest-first order without reversing', () => {
    render(<HistoryTimelineList items={oldestFirst} inputOrder="asc" />);
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('inputOrder="asc" with order="desc" reverses to newest-first', () => {
    render(<HistoryTimelineList items={oldestFirst} inputOrder="asc" order="desc" />);
    expect(titles()).toEqual(['Gamma', 'Beta', 'Alpha']);
  });

  it('default contract is unchanged: input is newest-first and order="asc" reverses it', () => {
    const newestFirst = [...oldestFirst].reverse();
    const { unmount } = render(<HistoryTimelineList items={newestFirst} />);
    expect(titles()).toEqual(['Gamma', 'Beta', 'Alpha']);
    unmount();
    render(<HistoryTimelineList items={newestFirst} order="asc" />);
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('HistoryTimelineList — bands', () => {
  const band: TimelineBandModel = { kind: 'band', id: 'enc-2', label: 'Encounter 2 - follow-up', tone: 'section' };
  const gap: TimelineBandModel = { kind: 'band', id: 'gap-1', label: 'Gap of 2 hours', tone: 'gap' };

  it('renders band rows as labelled separators, not articles', () => {
    render(<HistoryTimelineList items={[oldestFirst[0], gap, band, oldestFirst[1]]} inputOrder="asc" />);
    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(2);
    expect(screen.getByRole('separator', { name: 'Encounter 2 - follow-up' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Gap of 2 hours' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('numbers item positions among items only', () => {
    render(<HistoryTimelineList items={[oldestFirst[0], band, oldestFirst[1]]} inputOrder="asc" />);
    const articles = screen.getAllByRole('article');
    expect(articles[1].getAttribute('aria-posinset')).toBe('2');
    expect(articles[1].getAttribute('aria-setsize')).toBe('2');
  });
});

describe('HistoryTimelineList — selection', () => {
  it('selects on click and reflects aria-pressed on the selected row only', () => {
    const onItemSelect = vi.fn();
    render(<HistoryTimelineList items={oldestFirst} inputOrder="asc" selectedId="b" onItemSelect={onItemSelect} />);
    const beta = screen.getByRole('button', { name: 'Select Beta' });
    expect(beta.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Select Alpha' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
    expect(onItemSelect).toHaveBeenCalledWith('a');
  });

  it('is keyboard operable (Enter and Space on the focused select button)', () => {
    const onItemSelect = vi.fn();
    render(<HistoryTimelineList items={oldestFirst} inputOrder="asc" onItemSelect={onItemSelect} />);
    const gamma = screen.getByRole('button', { name: 'Select Gamma' });
    gamma.focus();
    expect(document.activeElement).toBe(gamma);
    // Native <button>: a keyboard activation is delivered as a click.
    expect(gamma.tagName).toBe('BUTTON');
    expect(gamma.getAttribute('type')).toBe('button');
    fireEvent.click(gamma);
    expect(onItemSelect).toHaveBeenCalledWith('c');
  });

  it('renders no select control when onItemSelect is absent', () => {
    render(<HistoryTimelineList items={oldestFirst} inputOrder="asc" />);
    expect(screen.queryByRole('button', { name: /^Select / })).toBeNull();
  });
});

describe('HistoryTimelineList — actions slot', () => {
  it('renders the per-item actions and does not trigger expand/select from them', () => {
    const onItemSelect = vi.fn();
    const onAct = vi.fn();
    render(
      <HistoryTimelineList
        items={oldestFirst}
        inputOrder="asc"
        onItemSelect={onItemSelect}
        actions={(m) => (
          <button type="button" onClick={() => onAct(m.id)}>
            Edit {String(m.title)}
          </button>
        )}
      />,
    );
    const first = screen.getAllByRole('article')[0];
    fireEvent.click(within(first).getByRole('button', { name: 'Edit Alpha' }));
    expect(onAct).toHaveBeenCalledWith('a');
    expect(onItemSelect).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /^Edit / })).toHaveLength(3);
  });
});

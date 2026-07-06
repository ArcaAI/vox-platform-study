import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScreenTemplate } from '../screen-template';
import { StatusFooter } from '../status-footer';

/** `a` precedes `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('ScreenTemplate', () => {
  it('renders the pinned regions in the standard priority order, then content, then footer', () => {
    render(
      <ScreenTemplate
        header={<div data-testid="header">Header</div>}
        stats={<div data-testid="stats">Stats</div>}
        statusBanner={<div data-testid="banner">Banner</div>}
        toolbar={<div data-testid="toolbar">Toolbar</div>}
        tabs={<div data-testid="tabs">Tabs</div>}
        footer={<div data-testid="footer">Footer</div>}
      >
        <div data-testid="content">Content</div>
      </ScreenTemplate>,
    );

    const order = ['header', 'stats', 'banner', 'toolbar', 'tabs', 'content', 'footer'].map((id) => screen.getByTestId(id));
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(precedes(order[i]!, order[i + 1]!)).toBe(true);
    }
  });

  it('omits optional regions and the footer wrapper when not provided', () => {
    render(
      <ScreenTemplate header={<div data-testid="header">Header</div>}>
        <div data-testid="content">Content</div>
      </ScreenTemplate>,
    );

    expect(screen.getByTestId('header')).toBeDefined();
    expect(screen.getByTestId('content')).toBeDefined();
    expect(screen.queryByTestId('stats')).toBeNull();
    expect(document.querySelector('footer')).toBeNull();
  });

  it('defaults to a scrolling content region (single scroll container)', () => {
    render(
      <ScreenTemplate header={<div>Header</div>}>
        <div data-testid="content">Content</div>
      </ScreenTemplate>,
    );

    const region = screen.getByTestId('content').parentElement!;
    expect(region.className).toContain('overflow-y-auto');
    expect(region.className).toContain('flex-1');
  });

  it('hands the height to a fill-height child (no nested scroll) in fill mode', () => {
    render(
      <ScreenTemplate header={<div>Header</div>} contentMode="fill">
        <div data-testid="grid">Grid</div>
      </ScreenTemplate>,
    );

    const region = screen.getByTestId('grid').parentElement!;
    expect(region.className).not.toContain('overflow-y-auto');
    expect(region.className).toContain('flex-1');
  });
});

describe('StatusFooter', () => {
  it('renders a labelled footer with a polite live region for the status message', () => {
    render(<StatusFooter start={<span>Ready</span>} end={<span>24 items</span>} />);

    const footer = document.querySelector('footer')!;
    expect(footer.getAttribute('aria-label')).toBe('Page status');
    expect(screen.getByText('Ready').closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByText('24 items')).toBeDefined();
  });
});

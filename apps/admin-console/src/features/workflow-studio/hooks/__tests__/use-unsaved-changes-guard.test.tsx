/**
 * `useUnsavedChangesGuard` (TASK-719 Task 15 remainder — README §7 "Still genuinely NOT done"
 * #3). Two layers, verified independently:
 *  1. `beforeunload` — standard tab-close/reload/external-nav guard.
 *  2. A capture-phase document click listener on same-origin anchor clicks — the Next.js App
 *     Router has no `router.events` equivalent to intercept programmatic navigation, so this
 *     covers the click-driven path (every nav affordance in this console — sidebar, breadcrumbs,
 *     `<Link>` — is a click on an anchor).
 */
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedChangesGuard } from '../use-unsaved-changes-guard';

function Harness({ shouldBlock }: { shouldBlock: boolean }) {
  useUnsavedChangesGuard(shouldBlock);
  return (
    <a href="/elsewhere" data-testid="nav-link">
      Elsewhere
    </a>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useUnsavedChangesGuard', () => {
  it('does nothing when shouldBlock is false: beforeunload is not prevented', () => {
    render(<Harness shouldBlock={false} />);
    const event = new Event('beforeunload', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('when shouldBlock is true, beforeunload is prevented (browser shows its own prompt)', () => {
    render(<Harness shouldBlock={true} />);
    const event = new Event('beforeunload', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('when shouldBlock is true and the user CANCELS the confirm, the anchor click is prevented', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const { getByTestId } = render(<Harness shouldBlock={true} />);
    const link = getByTestId('nav-link');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    act(() => {
      link.dispatchEvent(event);
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it('when shouldBlock is true and the user CONFIRMS, the anchor click is allowed through', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { getByTestId } = render(<Harness shouldBlock={true} />);
    const link = getByTestId('nav-link');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    act(() => {
      link.dispatchEvent(event);
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('when shouldBlock is false, an anchor click never prompts', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { getByTestId } = render(<Harness shouldBlock={false} />);
    const link = getByTestId('nav-link');
    act(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });
});

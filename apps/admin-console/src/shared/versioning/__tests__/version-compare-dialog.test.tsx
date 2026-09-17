/**
 * TASK-965 WS-3 — `VersionCompareDialog` (§3.1 point 7, OD-965-7).
 *
 * "Compare with previous" is the minimum diff affordance a versioned-item screen owes an admin
 * who is about to roll back: the activate confirm can name the CONSEQUENCE, but only a diff
 * answers "is this the version I mean". Both bodies are already in hand from the versions route,
 * so the whole comparison is client-side.
 *
 * `CodeEditor` (`@arcaai/ui`) is the console's JSON surface but it has no diff mode — it tokenises
 * one document and cannot tint per line — so the dialog renders its own two-pane / unified view
 * over `diffLines`, read-only, with the same mono type and line gutter.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { VersionCompareDialog } from '../version-compare-dialog';

afterEach(cleanup);

const FROM = { label: 'v2', value: { model: 'gpt-4o-mini', temperature: 0.2 } };
const TO = { label: 'v3', value: { model: 'gpt-4o', temperature: 0.2 } };

describe('VersionCompareDialog', () => {
  it('labels both sides and counts the change', () => {
    renderWithProviders(<VersionCompareDialog open onOpenChange={() => {}} from={FROM} to={TO} />);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('+1')).toBeDefined();
    expect(screen.getByText('−1')).toBeDefined();
  });

  it('starts split with one pane per version, and both panes are read-only', () => {
    renderWithProviders(<VersionCompareDialog open onOpenChange={() => {}} from={FROM} to={TO} />);
    expect(screen.getByRole('region', { name: 'v2' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'v3' })).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('switches to a unified view, with the mode buttons stating which one is on', () => {
    renderWithProviders(<VersionCompareDialog open onOpenChange={() => {}} from={FROM} to={TO} />);
    const unified = screen.getByRole('button', { name: 'Unified' });
    expect(unified.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(unified);
    expect(screen.getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: 'v2 compared with v3' })).toBeDefined();
  });

  it('never carries add/remove by colour alone — every changed line is prefixed (WCAG 1.4.1)', () => {
    renderWithProviders(<VersionCompareDialog open onOpenChange={() => {}} from={FROM} to={TO} defaultMode="unified" />);
    const unified = screen.getByRole('region', { name: 'v2 compared with v3' });
    expect(within(unified).getAllByText('+', { exact: true }).length).toBeGreaterThan(0);
    expect(within(unified).getAllByText('−', { exact: true }).length).toBeGreaterThan(0);
  });

  it('says the two versions are identical instead of showing an empty diff', () => {
    renderWithProviders(<VersionCompareDialog open onOpenChange={() => {}} from={FROM} to={{ label: 'v3', value: FROM.value }} />);
    expect(screen.getByText(/identical/i)).toBeDefined();
  });

  it('has no axe violations in either mode', async () => {
    renderWithProviders(<VersionCompareDialog open onOpenChange={() => {}} from={FROM} to={TO} />);
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
  });
});

/**
 * TASK-938 — the scribe footer offers exactly ONE auto row.
 *
 * The picker prepends its own `__auto__` sentinel ("no language declared" — the OD-1
 * default, and the only value that can express it since `''` cannot be a Radix item
 * value). The backend catalogue carries an auto mode of its own, so the two used to render
 * side by side reading almost identically while behaving differently: the sentinel keeps
 * the session on the agent's `ml-en` pair (unpinned, bilingual prompt), the catalogue one
 * replaces it with auto-detect (unpinned, no prompt). An owner session picked the wrong
 * one believing it was the default.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScribeFooter } from '../scribe-footer';

afterEach(cleanup);

/** The catalogue as `GET /audio/transcription-jobs/language-modes` returns it. */
const CATALOGUE = [
  { id: 'en', label: 'English', kind: 'single' as const },
  { id: 'ml', label: 'Malayalam', kind: 'single' as const },
  { id: 'ml-en', label: 'Malayalam + English', kind: 'code_switch' as const },
  { id: 'auto', label: 'Auto-detect', kind: 'auto' as const },
];

function renderFooter(overrides: Partial<React.ComponentProps<typeof ScribeFooter>> = {}) {
  return render(
    <ScribeFooter
      languageModes={CATALOGUE}
      selectedLanguageMode=""
      onLanguageModeChange={vi.fn()}
      languageModesLoading={false}
      metrics={{ tokensPerSecond: null, latencyP95Ms: null, uplinkBitsPerSecond: null }}
      {...overrides}
    />,
  );
}

/** The trigger renders the SELECTED label; the options live in the popover. */
function openPicker(): HTMLElement {
  const trigger = screen.getByRole('combobox', { name: 'Language' });
  trigger.click();
  return trigger;
}

/**
 * An option's text is its label with a KIND BADGE appended ("Auto", "Bilingual"), so
 * `textContent` reads e.g. `Auto (code-switch)Auto`. These tests are about WHICH modes are
 * offered, so compare on the label prefix and let the badge alone.
 */
async function optionLabels(): Promise<string[]> {
  const listbox = await screen.findByRole('listbox');
  return within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

describe('the scribe footer language picker', () => {
  it('shows the undeclared sentinel as the selection when nothing is declared', () => {
    renderFooter();
    expect(screen.getByRole('combobox', { name: 'Language' }).textContent).toContain('Auto (code-switch)');
  });

  it('drops the catalogue auto mode so only one auto row is offered', async () => {
    renderFooter();
    openPicker();
    const labels = await optionLabels();

    expect(labels.filter((label) => label.startsWith('Auto'))).toHaveLength(1);
    expect(labels.some((label) => label.startsWith('Auto (code-switch)'))).toBe(true);
    expect(labels.some((label) => label.startsWith('Auto-detect'))).toBe(false);
  });

  it('keeps every declarable mode the catalogue offers', async () => {
    renderFooter();
    openPicker();
    const labels = await optionLabels();

    expect(labels.some((label) => label.startsWith('English'))).toBe(true);
    expect(labels.some((label) => label.startsWith('Malayalam + English'))).toBe(true);
    // 'Malayalam' alone, not the bilingual pair that also starts with it.
    expect(labels.some((label) => label.startsWith('Malayalam') && !label.startsWith('Malayalam +'))).toBe(true);
  });

  it('drops a catalogue auto entry that omits `kind` (the field is optional)', async () => {
    renderFooter({ languageModes: [{ id: 'auto', label: 'Auto-detect' }, { id: 'en', label: 'English', kind: 'single' }] });
    openPicker();
    const labels = await optionLabels();

    expect(labels.map((label) => label.replace(/Auto$/, ''))).toEqual(['Auto (code-switch)', 'English']);
  });
});

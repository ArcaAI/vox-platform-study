import { test, expect } from '@playwright/experimental-ct-react';
import {
  DefaultLanguageModePicker,
  SelectedLanguageModePicker,
  LoadingLanguageModePicker,
  InteractiveLanguageModePicker,
} from '../fixtures/custom/stt-language-mode-picker-fixtures';

test.describe('SttLanguageModePicker', () => {
  test.describe('rendering', () => {
    test('renders with the default label', async ({ mount }) => {
      const component = await mount(<DefaultLanguageModePicker />);
      // `exact` matters: getByText does a case-insensitive SUBSTRING match, so a
      // bare 'Language' also matches the trigger's "Select a language"
      // placeholder and trips strict mode.
      await expect(component.getByText('Language', { exact: true })).toBeVisible();
    });

    test('shows the placeholder when no mode selected', async ({ mount }) => {
      const component = await mount(<DefaultLanguageModePicker />);
      await expect(component.getByText('Select a language')).toBeVisible();
    });

    test('shows the selected mode label', async ({ mount }) => {
      const component = await mount(<SelectedLanguageModePicker />);
      await expect(component.getByText('Malayalam + English')).toBeVisible();
    });

    test('flags a code-switch mode as Bilingual', async ({ mount }) => {
      const component = await mount(<SelectedLanguageModePicker />);
      await expect(component.getByText('Bilingual')).toBeVisible();
    });
  });

  test.describe('loading state', () => {
    test('renders a skeleton and no combobox while loading', async ({ mount }) => {
      const component = await mount(<LoadingLanguageModePicker />);
      await expect(component.locator('button[data-slot="select-trigger"]')).toHaveCount(0);
    });
  });

  test.describe('interaction', () => {
    test('selecting a mode reports its id', async ({ mount, page }) => {
      const component = await mount(<InteractiveLanguageModePicker />);
      await component.locator('button[data-slot="select-trigger"]').click();
      // Radix renders SelectContent in a portal on document.body, OUTSIDE the
      // mounted subtree — the option has to be located from `page`, not
      // `component`, or the click waits forever.
      await page.getByRole('option', { name: /Malayalam \+ English/ }).click();
      await expect(component.getByTestId('selected-mode')).toHaveText('ml-en');
    });
  });
});

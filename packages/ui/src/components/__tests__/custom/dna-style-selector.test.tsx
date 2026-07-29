import { test, expect } from '@playwright/experimental-ct-react';
import {
  DefaultDnaSelector,
  SelectedDnaSelector,
  LoadingDnaSelector,
  EmptyDnaSelector,
  InteractiveDnaSelector,
} from '../fixtures/custom/dna-style-selector-fixtures';

test.describe('DnaStyleSelector', () => {
  test.describe('rendering', () => {
    test('renders all style options', async ({ mount }) => {
      const component = await mount(<DefaultDnaSelector />);
      await expect(component.getByText('Concise Clinical')).toBeVisible();
      await expect(component.getByText('Narrative Medical')).toBeVisible();
      await expect(component.getByText('Structured Report')).toBeVisible();
    });

    test('shows preview text for each style', async ({ mount }) => {
      const component = await mount(<DefaultDnaSelector />);
      await expect(component.getByText('Short, direct sentences.')).toBeVisible();
      await expect(component.getByText('Flowing prose style.')).toBeVisible();
    });

    test('highlights selected style', async ({ mount }) => {
      const component = await mount(<SelectedDnaSelector />);
      const selected = component.locator('button').filter({ hasText: 'Narrative Medical' });
      await expect(selected).toHaveClass(/border-primary/);
    });

    test('shows Active badge on selected style', async ({ mount }) => {
      const component = await mount(<SelectedDnaSelector />);
      await expect(component.getByText('Active')).toBeVisible();
    });

    test('does not show Active badge on unselected styles', async ({ mount }) => {
      const component = await mount(<SelectedDnaSelector />);
      const badges = component.locator('[data-slot="badge"]').filter({ hasText: 'Active' });
      await expect(badges).toHaveCount(1);
    });
  });

  test.describe('loading state', () => {
    test('shows skeleton placeholders', async ({ mount }) => {
      const component = await mount(<LoadingDnaSelector />);
      await expect(component.locator('.animate-pulse').first()).toBeVisible();
    });

    test('does not show style buttons when loading', async ({ mount }) => {
      const component = await mount(<LoadingDnaSelector />);
      await expect(component.getByText('Concise Clinical')).toHaveCount(0);
    });
  });

  test.describe('empty state', () => {
    test('shows empty state message', async ({ mount }) => {
      const component = await mount(<EmptyDnaSelector />);
      await expect(component.getByText('No DNA writing style found')).toBeVisible();
    });

    test('shows generate button when onGenerate is provided', async ({ mount }) => {
      const component = await mount(<EmptyDnaSelector onGenerate={() => {}} />);
      await expect(component.getByText('Generate DNA Style')).toBeVisible();
    });
  });

  test.describe('interactions', () => {
    test('clicking a style selects it', async ({ mount }) => {
      const component = await mount(<InteractiveDnaSelector />);
      await component.getByText('Concise Clinical').click();
      await expect(component.locator('[data-testid="selected-style"]')).toHaveText('concise');
    });

    test('clicking a different style changes selection', async ({ mount }) => {
      const component = await mount(<InteractiveDnaSelector />);
      await component.getByText('Concise Clinical').click();
      await expect(component.locator('[data-testid="selected-style"]')).toHaveText('concise');

      await component.getByText('Structured Report').click();
      await expect(component.locator('[data-testid="selected-style"]')).toHaveText('structured');
    });
  });

  test.describe('accessibility', () => {
    test('style buttons are focusable', async ({ mount }) => {
      const component = await mount(<DefaultDnaSelector />);
      const firstButton = component.locator('button').filter({ hasText: 'Concise Clinical' });
      await firstButton.focus();
      await expect(firstButton).toBeFocused();
    });

    test('style buttons have focus-visible ring', async ({ mount }) => {
      const component = await mount(<DefaultDnaSelector />);
      const firstButton = component.locator('button').filter({ hasText: 'Concise Clinical' });
      await expect(firstButton).toHaveClass(/focus-visible:ring-2/);
    });

    test('buttons are keyboard activatable', async ({ mount }) => {
      const component = await mount(<InteractiveDnaSelector />);
      const button = component.locator('button').filter({ hasText: 'Narrative Medical' });
      await button.focus();
      await button.press('Enter');
      await expect(component.locator('[data-testid="selected-style"]')).toHaveText('narrative');
    });
  });
});

import { test, expect } from '@playwright/experimental-ct-react';
import { DefaultSelector, PreselectedSelector, LoadingSelector } from '../fixtures/custom/dept-prompt-selector-fixtures';

test.describe('DeptPromptSelector', () => {
  test.describe('rendering', () => {
    test('renders both selectors', async ({ mount }) => {
      const component = await mount(<DefaultSelector />);
      await expect(component.getByText('Department', { exact: true })).toBeVisible();
      await expect(component.getByText('Prompt Template', { exact: true })).toBeVisible();
    });

    test('shows placeholder text when nothing selected', async ({ mount }) => {
      const component = await mount(<DefaultSelector />);
      await expect(component.getByText('Select a department', { exact: true })).toBeVisible();
      await expect(component.getByText('Select a department first', { exact: true })).toBeVisible();
    });

    test('shows selected values when preselected', async ({ mount }) => {
      const component = await mount(<PreselectedSelector />);
      await expect(component.getByText('Cardiology')).toBeVisible();
      await expect(component.getByText('Initial Consultation')).toBeVisible();
    });
  });

  test.describe('loading state', () => {
    test('shows loading text in both selectors', async ({ mount }) => {
      const component = await mount(<LoadingSelector />);
      const loadingTexts = component.getByText('Loading...');
      await expect(loadingTexts.first()).toBeVisible();
    });

    test('disables selectors when loading', async ({ mount }) => {
      const component = await mount(<LoadingSelector />);
      const triggers = component.locator('button[data-slot="select-trigger"]');
      await expect(triggers.first()).toBeDisabled();
      await expect(triggers.last()).toBeDisabled();
    });
  });

  test.describe('prompt selector dependency', () => {
    test('prompt selector is disabled when no department selected', async ({ mount }) => {
      const component = await mount(<DefaultSelector />);
      const triggers = component.locator('button[data-slot="select-trigger"]');
      await expect(triggers.last()).toBeDisabled();
    });

    test('prompt selector is enabled when department is selected', async ({ mount }) => {
      const component = await mount(<PreselectedSelector />);
      const triggers = component.locator('button[data-slot="select-trigger"]');
      await expect(triggers.last()).toBeEnabled();
    });
  });

  test.describe('icons', () => {
    test('shows department and prompt icons in labels', async ({ mount }) => {
      const component = await mount(<DefaultSelector />);
      const labels = component.locator('label');
      await expect(labels.first()).toBeVisible();
      await expect(labels.last()).toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('labels are associated with selectors', async ({ mount }) => {
      const component = await mount(<DefaultSelector />);
      await expect(component.getByText('Department', { exact: true })).toBeVisible();
      await expect(component.getByText('Prompt Template', { exact: true })).toBeVisible();
    });

    test('disabled state is communicated', async ({ mount }) => {
      const component = await mount(<LoadingSelector />);
      const triggers = component.locator('button[data-slot="select-trigger"]');
      await expect(triggers.first()).toBeDisabled();
    });
  });
});

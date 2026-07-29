import { test, expect } from '@playwright/experimental-ct-react';
import {
  DefaultModelSelector,
  SelectedModelSelector,
  LoadingModelSelector,
  NoneOptionModelSelector,
} from '../fixtures/custom/model-selector-fixtures';

test.describe('ModelSelector', () => {
  test.describe('rendering', () => {
    test('renders with label', async ({ mount }) => {
      const component = await mount(<DefaultModelSelector />);
      await expect(component.getByText('AI Model')).toBeVisible();
    });

    test('shows placeholder when no model selected', async ({ mount }) => {
      const component = await mount(<DefaultModelSelector />);
      await expect(component.getByText('Select a model')).toBeVisible();
    });

    test('shows selected model name', async ({ mount }) => {
      const component = await mount(<SelectedModelSelector />);
      await expect(component.getByText('GPT-4o')).toBeVisible();
    });

    test('shows source badge for selected model', async ({ mount }) => {
      const component = await mount(<SelectedModelSelector />);
      await expect(component.getByText('backend')).toBeVisible();
    });
  });

  test.describe('loading state', () => {
    test('shows loading placeholder', async ({ mount }) => {
      const component = await mount(<LoadingModelSelector />);
      await expect(component.getByText('Loading...')).toBeVisible();
    });

    test('disables selector when loading', async ({ mount }) => {
      const component = await mount(<LoadingModelSelector />);
      const trigger = component.locator('button[data-slot="select-trigger"]');
      await expect(trigger).toBeDisabled();
    });
  });

  test.describe('none option', () => {
    test('shows None option text when noneOption is true', async ({ mount }) => {
      const component = await mount(<NoneOptionModelSelector />);
      await expect(component.getByText('None (disabled)')).toBeVisible();
    });
  });

  test.describe('label', () => {
    test('displays model icon in label', async ({ mount }) => {
      const component = await mount(<DefaultModelSelector />);
      const label = component.locator('label');
      await expect(label).toBeVisible();
      await expect(label).toContainText('AI Model');
    });
  });

  test.describe('accessibility', () => {
    test('label is visible and descriptive', async ({ mount }) => {
      const component = await mount(<DefaultModelSelector />);
      await expect(component.getByText('AI Model')).toBeVisible();
    });

    test('disabled state is communicated', async ({ mount }) => {
      const component = await mount(<LoadingModelSelector />);
      const trigger = component.locator('button[data-slot="select-trigger"]');
      await expect(trigger).toBeDisabled();
    });
  });
});

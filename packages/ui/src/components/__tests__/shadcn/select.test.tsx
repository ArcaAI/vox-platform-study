import { test, expect } from '@playwright/experimental-ct-react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../shadcn/select';
import { BasicSelect, GroupedSelect, SelectWithDisabledItems } from '../fixtures/shadcn/select-fixtures';

test.describe('Select', () => {
  test.describe('rendering', () => {
    test('renders trigger with placeholder', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.locator('[data-slot="select-trigger"]');
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText('Select an option');
    });

    test('renders with custom placeholder', async ({ mount, page }) => {
      await mount(<BasicSelect placeholder="Choose fruit" />);
      const trigger = page.locator('[data-slot="select-trigger"]');
      await expect(trigger).toContainText('Choose fruit');
    });

    test('renders with default value', async ({ mount, page }) => {
      await mount(<BasicSelect defaultValue="apple" />);
      const trigger = page.locator('[data-slot="select-trigger"]');
      await expect(trigger).toContainText('Apple');
    });

    test('trigger has combobox role', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      await expect(page.getByRole('combobox')).toBeVisible();
    });

    test('content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const content = page.locator('[data-slot="select-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('trigger sizes', () => {
    test('renders default size trigger', async ({ mount, page }) => {
      await mount(
        <Select>
          <SelectTrigger size="default">
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="test">Test</SelectItem>
          </SelectContent>
        </Select>,
      );
      const trigger = page.locator('[data-slot="select-trigger"]');
      await expect(trigger).toHaveAttribute('data-size', 'default');
      await expect(trigger).toHaveClass(/data-\[size=default\]:h-9/);
    });

    test('renders sm size trigger', async ({ mount, page }) => {
      await mount(
        <Select>
          <SelectTrigger size="sm">
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="test">Test</SelectItem>
          </SelectContent>
        </Select>,
      );
      const trigger = page.locator('[data-slot="select-trigger"]');
      await expect(trigger).toHaveAttribute('data-size', 'sm');
      await expect(trigger).toHaveClass(/data-\[size=sm\]:h-8/);
    });
  });

  test.describe('opening and closing', () => {
    test('opens dropdown when trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      const content = page.locator('[data-slot="select-content"]');
      await expect(content).toBeVisible();
    });

    test('shows all options when opened', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await expect(page.getByRole('option', { name: 'Apple' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Banana' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Cherry' })).toBeVisible();
    });

    test('closes dropdown when option is selected', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await page.getByRole('option', { name: 'Apple' }).click();

      const content = page.locator('[data-slot="select-content"]');
      await expect(content).not.toBeVisible();
    });

    test('closes dropdown when Escape is pressed', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await page.keyboard.press('Escape');

      const content = page.locator('[data-slot="select-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('selection', () => {
    test('selects option when clicked', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await page.getByRole('option', { name: 'Banana' }).click();

      await expect(trigger).toContainText('Banana');
    });

    test('shows check mark on selected item', async ({ mount, page }) => {
      await mount(<BasicSelect defaultValue="apple" />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      const appleOption = page.getByRole('option', { name: 'Apple' });
      await expect(appleOption).toHaveAttribute('data-state', 'checked');
    });
  });

  test.describe('keyboard navigation', () => {
    test('opens with Enter key', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.focus();
      await trigger.press('Enter');

      const content = page.locator('[data-slot="select-content"]');
      await expect(content).toBeVisible();
    });

    test('opens with Space key', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.focus();
      await trigger.press(' ');

      const content = page.locator('[data-slot="select-content"]');
      await expect(content).toBeVisible();
    });

    test('navigates options with arrow keys', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');

      const bananaOption = page.getByRole('option', { name: 'Banana' });
      await expect(bananaOption).toHaveAttribute('data-highlighted');
    });

    test('selects highlighted option with Enter', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await expect(page.getByRole('listbox')).toBeVisible();
      await expect(page.getByRole('option', { name: 'Apple' })).toBeVisible();

      await page.keyboard.press('Enter');

      await expect(trigger).toContainText('Apple');
    });
  });

  test.describe('disabled state', () => {
    test('trigger is disabled when select is disabled', async ({ mount, page }) => {
      await mount(<BasicSelect disabled />);
      const trigger = page.getByRole('combobox');
      await expect(trigger).toBeDisabled();
    });

    test('cannot open when disabled', async ({ mount, page }) => {
      await mount(<BasicSelect disabled />);
      const trigger = page.getByRole('combobox');
      await trigger.click({ force: true });

      const content = page.locator('[data-slot="select-content"]');
      await expect(content).not.toBeVisible();
    });

    test('disabled items cannot be selected', async ({ mount, page }) => {
      await mount(<SelectWithDisabledItems />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      const disabledOption = page.getByRole('option', { name: 'Disabled' });
      await expect(disabledOption).toHaveAttribute('data-disabled', '');
    });
  });

  test.describe('grouped items', () => {
    test('renders groups with labels', async ({ mount, page }) => {
      await mount(<GroupedSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      await expect(page.getByText('Fruits')).toBeVisible();
      await expect(page.getByText('Vegetables')).toBeVisible();
    });

    test('renders separator between groups', async ({ mount, page }) => {
      await mount(<GroupedSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.click();

      const separator = page.locator('[data-slot="select-separator"]');
      await expect(separator).toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('trigger has combobox role', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      await expect(page.getByRole('combobox')).toBeVisible();
    });

    test('trigger has aria-expanded false initially', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    test('options have option role', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      await page.getByRole('combobox').click();

      const options = page.getByRole('option');
      await expect(options).toHaveCount(3);
    });

    test('listbox has listbox role', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      await page.getByRole('combobox').click();

      await expect(page.getByRole('listbox')).toBeVisible();
    });

    test('supports aria-label on trigger', async ({ mount, page }) => {
      await mount(
        <Select>
          <SelectTrigger aria-label="Fruit selection">
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="test">Test</SelectItem>
          </SelectContent>
        </Select>,
      );
      const trigger = page.getByRole('combobox');
      await expect(trigger).toHaveAccessibleName('Fruit selection');
    });
  });

  test.describe('styling', () => {
    test('trigger has correct default styling', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.locator('[data-slot="select-trigger"]');
      await expect(trigger).toHaveClass(/border/);
      await expect(trigger).toHaveClass(/rounded-md/);
    });

    test('shows chevron icon', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.locator('[data-slot="select-trigger"]');
      const chevron = trigger.locator('svg');
      await expect(chevron).toBeVisible();
    });
  });

  test.describe('focus management', () => {
    test('trigger is focusable', async ({ mount, page }) => {
      await mount(<BasicSelect />);
      const trigger = page.getByRole('combobox');
      await trigger.focus();
      await expect(trigger).toBeFocused();
    });
  });
});

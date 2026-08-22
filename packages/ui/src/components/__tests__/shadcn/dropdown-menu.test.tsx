import { test, expect } from '@playwright/experimental-ct-react';
import { BasicDropdownMenu } from '../fixtures/shadcn/dropdown-menu-fixtures';

test.describe('DropdownMenu', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await expect(trigger).toBeVisible();
    });

    test('menu content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const content = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(content).not.toBeVisible();
    });

    test('trigger has correct data-slot', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await expect(trigger).toHaveAttribute('data-slot', 'dropdown-menu-trigger');
    });
  });

  test.describe('opening and closing', () => {
    test('opens menu when trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const content = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(content).toBeVisible();
    });

    test('closes menu when Escape is pressed', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const content = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(content).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(content).not.toBeVisible();
    });

    test('closes menu when an item is clicked', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const settingsItem = page.locator('[data-slot="dropdown-menu-item"]:has-text("Settings")');
      await settingsItem.click();

      const content = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('menu items', () => {
    test('renders menu items', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const profileItem = page.locator('[data-slot="dropdown-menu-item"]:has-text("Profile")');
      await expect(profileItem).toBeVisible();

      const settingsItem = page.locator('[data-slot="dropdown-menu-item"]:has-text("Settings")');
      await expect(settingsItem).toBeVisible();
    });

    test('renders destructive variant item', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const deleteItem = page.locator('[data-slot="dropdown-menu-item"]:has-text("Delete")');
      await expect(deleteItem).toBeVisible();
      await expect(deleteItem).toHaveAttribute('data-variant', 'destructive');
    });

    test('renders checkbox item with checked state', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const checkboxItem = page.locator('[data-slot="dropdown-menu-checkbox-item"]');
      await expect(checkboxItem).toBeVisible();
      await expect(checkboxItem).toHaveAttribute('data-state', 'checked');
    });
  });

  test.describe('label and separator', () => {
    test('renders menu label', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const label = page.locator('[data-slot="dropdown-menu-label"]');
      await expect(label).toBeVisible();
      await expect(label).toHaveText('My Account');
    });

    test('renders separators', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const separators = page.locator('[data-slot="dropdown-menu-separator"]');
      const count = await separators.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  test.describe('shortcut', () => {
    test('renders shortcut text', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const shortcut = page.locator('[data-slot="dropdown-menu-shortcut"]');
      await expect(shortcut).toBeVisible();
      await expect(shortcut).toHaveText('⇧⌘P');
    });

    test('shortcut has muted text styling', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const shortcut = page.locator('[data-slot="dropdown-menu-shortcut"]');
      await expect(shortcut).toHaveClass(/text-muted-foreground/);
      await expect(shortcut).toHaveClass(/text-xs/);
    });
  });

  test.describe('keyboard navigation', () => {
    test('navigates items with arrow keys', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');

      const focused = page.locator('[data-slot="dropdown-menu-item"]:focus');
      await expect(focused).toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('menu has correct role', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
    });

    test('menu items have menuitem role', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const menuItems = page.getByRole('menuitem');
      const count = await menuItems.count();
      expect(count).toBeGreaterThanOrEqual(2);
    });

    test('checkbox item has menuitemcheckbox role', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const checkboxItem = page.getByRole('menuitemcheckbox');
      await expect(checkboxItem).toBeVisible();
    });

    test('trigger indicates expanded state', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.locator('[data-slot="dropdown-menu-trigger"]');

      await expect(trigger).toHaveAttribute('data-state', 'closed');

      await trigger.click();

      await expect(trigger).toHaveAttribute('data-state', 'open');
    });
  });

  test.describe('styling', () => {
    test('content has popover background', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const content = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(content).toHaveClass(/bg-popover/);
      await expect(content).toHaveClass(/rounded-surface/);
      await expect(content).toHaveClass(/border/);
    });

    test('label has correct font styling', async ({ mount, page }) => {
      await mount(<BasicDropdownMenu />);
      const trigger = page.getByRole('button', { name: 'Open Menu' });
      await trigger.click();

      const label = page.locator('[data-slot="dropdown-menu-label"]');
      await expect(label).toHaveClass(/font-medium/);
      await expect(label).toHaveClass(/text-sm/);
    });
  });
});

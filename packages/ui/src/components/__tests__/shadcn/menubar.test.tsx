import { test, expect } from '@playwright/experimental-ct-react';
import { BasicMenubar, MenubarWithCustomClass } from '../fixtures/shadcn/menubar-fixtures';

test.describe('Menubar', () => {
  test.describe('rendering', () => {
    test('renders menubar', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toBeVisible();
    });

    test('renders trigger buttons', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      const editTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'Edit' });
      await expect(fileTrigger).toBeVisible();
      await expect(editTrigger).toBeVisible();
    });

    test('menu content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const content = page.locator('[data-slot="menubar-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('opening', () => {
    test('opens menu when trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const content = page.locator('[data-slot="menubar-content"]').first();
      await expect(content).toBeVisible();
    });

    test('opens different menu when another trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const editTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'Edit' });
      await editTrigger.click();

      const content = page.locator('[data-slot="menubar-content"]');
      await expect(content.filter({ hasText: 'Undo' })).toBeVisible();
    });
  });

  test.describe('content', () => {
    test('renders menu items when open', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const newTabItem = page.locator('[data-slot="menubar-item"]').filter({ hasText: 'New Tab' });
      const newWindowItem = page.locator('[data-slot="menubar-item"]').filter({ hasText: 'New Window' });
      const printItem = page.locator('[data-slot="menubar-item"]').filter({ hasText: 'Print' });
      await expect(newTabItem).toBeVisible();
      await expect(newWindowItem).toBeVisible();
      await expect(printItem).toBeVisible();
    });

    test('renders menu label', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const label = page.locator('[data-slot="menubar-label"]');
      await expect(label).toBeVisible();
      await expect(label).toHaveText('File Actions');
    });

    test('renders separator', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const separator = page.locator('[data-slot="menubar-separator"]');
      await expect(separator).toBeVisible();
    });

    test('renders shortcut text', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const shortcut = page.locator('[data-slot="menubar-shortcut"]');
      await expect(shortcut).toBeVisible();
      await expect(shortcut).toHaveText('⌘T');
    });
  });

  test.describe('interactions', () => {
    test('clicking a menu item closes the menu', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const printItem = page.locator('[data-slot="menubar-item"]').filter({ hasText: 'Print' });
      await printItem.click();

      const content = page.locator('[data-slot="menubar-content"]').first();
      await expect(content).not.toBeVisible();
    });

    test('pressing Escape closes the menu', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const content = page.locator('[data-slot="menubar-content"]').first();
      await expect(content).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('styling', () => {
    test('menubar has border class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toHaveClass(/border/);
    });

    test('menubar has rounded-surface class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toHaveClass(/rounded-surface/);
    });

    test('menubar has h-9 class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toHaveClass(/h-9/);
    });

    test('menu content has rounded-surface class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const content = page.locator('[data-slot="menubar-content"]').first();
      await expect(content).toHaveClass(/rounded-surface/);
    });

    test('menu content has border class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const content = page.locator('[data-slot="menubar-content"]').first();
      await expect(content).toHaveClass(/border/);
    });

    test('menu content has shadow-overlay class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const content = page.locator('[data-slot="menubar-content"]').first();
      await expect(content).toHaveClass(/shadow-overlay/);
    });

    test('shortcut has text-muted-foreground class', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const shortcut = page.locator('[data-slot="menubar-shortcut"]');
      await expect(shortcut).toHaveClass(/text-muted-foreground/);
    });
  });

  test.describe('accessibility', () => {
    test('menubar has menubar role', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menubar = page.getByRole('menubar');
      await expect(menubar).toBeVisible();
    });

    test('triggers have menuitem role', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menuItems = page.getByRole('menuitem');
      await expect(menuItems).toHaveCount(2);
    });

    test('menu items have menuitem role when open', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const fileTrigger = page.locator('[data-slot="menubar-trigger"]').filter({ hasText: 'File' });
      await fileTrigger.click();

      const menuItems = page.getByRole('menuitem');
      const count = await menuItems.count();
      expect(count).toBeGreaterThan(2);
    });

    test('menubar has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicMenubar />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toHaveAttribute('data-slot', 'menubar');
    });
  });

  test.describe('custom className', () => {
    test('supports custom className on Menubar', async ({ mount, page }) => {
      await mount(<MenubarWithCustomClass />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toHaveClass(/custom-menubar-class/);
    });

    test('preserves default classes with custom className', async ({ mount, page }) => {
      await mount(<MenubarWithCustomClass />);
      const menubar = page.locator('[data-slot="menubar"]');
      await expect(menubar).toHaveClass(/rounded-surface/);
      await expect(menubar).toHaveClass(/custom-menubar-class/);
    });
  });
});

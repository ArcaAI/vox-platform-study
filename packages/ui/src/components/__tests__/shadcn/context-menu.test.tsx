import { test, expect } from '@playwright/experimental-ct-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuShortcut,
} from '../../shadcn/context-menu';
import { BasicContextMenu } from '../fixtures/shadcn/context-menu-fixtures';

test.describe('ContextMenu', () => {
  test.describe('rendering', () => {
    test('renders trigger area', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);
      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText('Right click here');
    });

    test('menu content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);
      const content = page.locator('[data-slot="context-menu-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('opening and closing', () => {
    test('opens on right-click', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const content = page.locator('[data-slot="context-menu-content"]');
      await expect(content).toBeVisible();
    });

    test('shows menu items when open', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const copyItem = page.locator('[data-slot="context-menu-item"]').filter({
        hasText: 'Copy',
      });
      await expect(copyItem).toBeVisible();

      const pasteItem = page.locator('[data-slot="context-menu-item"]').filter({ hasText: 'Paste' });
      await expect(pasteItem).toBeVisible();
    });

    test('closes when Escape is pressed', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const content = page.locator('[data-slot="context-menu-content"]');
      await expect(content).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(content).not.toBeVisible();
    });

    test('closes when clicking outside', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const content = page.locator('[data-slot="context-menu-content"]');
      await expect(content).toBeVisible();

      await page.mouse.click(0, 0);
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('menu items', () => {
    test('renders label', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const label = page.locator('[data-slot="context-menu-label"]');
      await expect(label).toBeVisible();
      await expect(label).toHaveText('Actions');
    });

    test('renders separator', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const separators = page.locator('[data-slot="context-menu-separator"]');
      const count = await separators.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    test('renders shortcut text', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const shortcut = page.locator('[data-slot="context-menu-shortcut"]');
      await expect(shortcut).toBeVisible();
      await expect(shortcut).toHaveText('⌘D');
    });

    test('renders checkbox item with check indicator', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const checkboxItem = page.locator('[data-slot="context-menu-checkbox-item"]');
      await expect(checkboxItem).toBeVisible();
      await expect(checkboxItem).toContainText('Show Toolbar');
    });
  });

  test.describe('variants', () => {
    test('destructive item has data-variant', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const destructiveItem = page.locator('[data-slot="context-menu-item"]').filter({ hasText: 'Delete' });
      await expect(destructiveItem).toHaveAttribute('data-variant', 'destructive');
    });

    test('default items have default variant', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const copyItem = page.locator('[data-slot="context-menu-item"]').filter({
        hasText: 'Copy',
      });
      await expect(copyItem).toHaveAttribute('data-variant', 'default');
    });

    test('inset item has data-inset attribute', async ({ mount, page }) => {
      await mount(
        <ContextMenu>
          <ContextMenuTrigger>
            <div style={{ width: 200, height: 100 }}>Trigger</div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem inset>Inset Item</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>,
      );

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const insetItem = page.locator('[data-slot="context-menu-item"]');
      await expect(insetItem).toHaveAttribute('data-inset', 'true');
    });
  });

  test.describe('keyboard navigation', () => {
    test('navigates items with arrow keys', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');

      const highlightedItem = page.locator('[data-slot="context-menu-item"][data-highlighted]');
      await expect(highlightedItem).toBeVisible();
    });

    test('selects item with Enter key', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');

      const content = page.locator('[data-slot="context-menu-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('menu content has menu role', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
    });

    test('menu items have menuitem role', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const menuItems = page.getByRole('menuitem');
      const count = await menuItems.count();
      expect(count).toBeGreaterThan(0);
    });

    test('checkbox item has menuitemcheckbox role', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const checkboxItem = page.getByRole('menuitemcheckbox');
      await expect(checkboxItem).toBeVisible();
    });

    test('checked checkbox item has aria-checked true', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const checkboxItem = page.getByRole('menuitemcheckbox');
      await expect(checkboxItem).toHaveAttribute('aria-checked', 'true');
    });

    test('label styling has correct classes', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const label = page.locator('[data-slot="context-menu-label"]');
      await expect(label).toHaveClass(/font-medium/);
    });

    test('separator has separator role', async ({ mount, page }) => {
      await mount(<BasicContextMenu />);

      const trigger = page.locator('[data-slot="context-menu-trigger"]');
      await trigger.click({ button: 'right' });

      const separators = page.getByRole('separator');
      const count = await separators.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });
});

import { test, expect } from '@playwright/experimental-ct-react';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut } from '../../shadcn/command';
import { BasicCommand } from '../fixtures/shadcn/command-fixtures';

test.describe('Command', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const command = page.locator('[data-slot="command"]');
      await expect(command).toBeVisible();
    });

    test('renders input with data-slot', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const input = page.locator('[data-slot="command-input"]');
      await expect(input).toBeVisible();
    });

    test('renders input wrapper with data-slot', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const wrapper = page.locator('[data-slot="command-input-wrapper"]');
      await expect(wrapper).toBeVisible();
    });

    test('renders command list with data-slot', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const list = page.locator('[data-slot="command-list"]');
      await expect(list).toBeVisible();
    });

    test('renders input placeholder', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const input = page.locator('[data-slot="command-input"]');
      await expect(input).toHaveAttribute('placeholder', 'Type a command...');
    });

    test('applies custom className', async ({ mount, page }) => {
      await mount(
        <Command className="custom-command">
          <CommandList>
            <CommandItem>Item</CommandItem>
          </CommandList>
        </Command>,
      );

      const command = page.locator('[data-slot="command"]');
      await expect(command).toHaveClass(/custom-command/);
    });
  });

  test.describe('groups', () => {
    test('renders command groups', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const groups = page.locator('[data-slot="command-group"]');
      await expect(groups).toHaveCount(2);
    });

    test('renders group headings', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const command = page.locator('[data-slot="command"]');
      await expect(command).toContainText('Suggestions');
      await expect(command).toContainText('Actions');
    });

    test('renders items within groups', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const items = page.locator('[data-slot="command-item"]');
      await expect(items).toHaveCount(5);
    });

    test('renders separator between groups', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const separator = page.locator('[data-slot="command-separator"]');
      await expect(separator).toBeVisible();
    });
  });

  test.describe('filtering', () => {
    test('filters items based on input', async ({ mount, page }) => {
      await mount(<BasicCommand />);

      const input = page.locator('[data-slot="command-input"]');
      await input.fill('Cal');

      const visibleItems = page.locator('[data-slot="command-item"]:not([hidden])');
      await expect(visibleItems.first()).toContainText('Calendar');
    });

    test('shows empty state when no results match', async ({ mount, page }) => {
      await mount(<BasicCommand />);

      const input = page.locator('[data-slot="command-input"]');
      await input.fill('zzzznonexistent');

      const empty = page.locator('[data-slot="command-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toHaveText('No results found.');
    });

    test('shows all items when input is cleared', async ({ mount, page }) => {
      await mount(<BasicCommand />);

      const input = page.locator('[data-slot="command-input"]');
      await input.fill('Cal');
      await input.fill('');

      const items = page.locator('[data-slot="command-item"]');
      await expect(items).toHaveCount(5);
    });
  });

  test.describe('keyboard navigation', () => {
    test('highlights item on arrow down', async ({ mount, page }) => {
      await mount(<BasicCommand />);

      const input = page.locator('[data-slot="command-input"]');
      await input.focus();
      await page.keyboard.press('ArrowDown');

      const selectedItem = page.locator('[data-slot="command-item"][data-selected="true"]');
      await expect(selectedItem).toBeVisible();
    });

    test('navigates through items with arrow keys', async ({ mount, page }) => {
      await mount(<BasicCommand />);

      const input = page.locator('[data-slot="command-input"]');
      await input.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');

      const selectedItem = page.locator('[data-slot="command-item"][data-selected="true"]');
      await expect(selectedItem).toBeVisible();
    });
  });

  test.describe('shortcut', () => {
    test('renders shortcut text', async ({ mount, page }) => {
      await mount(
        <Command>
          <CommandList>
            <CommandItem>
              Copy
              <CommandShortcut>⌘C</CommandShortcut>
            </CommandItem>
          </CommandList>
        </Command>,
      );

      const shortcut = page.locator('[data-slot="command-shortcut"]');
      await expect(shortcut).toBeVisible();
      await expect(shortcut).toHaveText('⌘C');
    });

    test('shortcut has muted styling', async ({ mount, page }) => {
      await mount(
        <Command>
          <CommandList>
            <CommandItem>
              Copy
              <CommandShortcut>⌘C</CommandShortcut>
            </CommandItem>
          </CommandList>
        </Command>,
      );

      const shortcut = page.locator('[data-slot="command-shortcut"]');
      await expect(shortcut).toHaveClass(/text-muted-foreground/);
    });
  });

  test.describe('empty state', () => {
    test('renders empty component with data-slot', async ({ mount, page }) => {
      await mount(
        <Command>
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
          </CommandList>
        </Command>,
      );

      const empty = page.locator('[data-slot="command-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toHaveText('No results found.');
    });
  });

  test.describe('accessibility', () => {
    test('input has role combobox', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const input = page.locator('[data-slot="command-input"]');
      await expect(input).toHaveRole('combobox');
    });

    test('items have role option', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const items = page.locator('[data-slot="command-item"]');
      const firstItem = items.first();
      await expect(firstItem).toHaveRole('option');
    });

    test('list has role listbox', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const list = page.locator('[data-slot="command-list"]');
      await expect(list).toHaveRole('listbox');
    });

    test('input is focusable', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const input = page.locator('[data-slot="command-input"]');
      await input.focus();
      await expect(input).toBeFocused();
    });

    test('input has aria-expanded attribute', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const input = page.locator('[data-slot="command-input"]');
      const expanded = await input.getAttribute('aria-expanded');
      expect(expanded).toBeTruthy();
    });

    test('input has aria-autocomplete', async ({ mount, page }) => {
      await mount(<BasicCommand />);
      const input = page.locator('[data-slot="command-input"]');
      await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    });
  });
});

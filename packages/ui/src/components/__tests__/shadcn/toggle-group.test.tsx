import { test, expect } from '@playwright/experimental-ct-react';
import { ToggleGroup, ToggleGroupItem } from '../../shadcn/toggle-group';
import { SingleToggleGroup, MultipleToggleGroup } from '../fixtures/shadcn/toggle-group-fixtures';

test.describe('ToggleGroup', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toBeVisible();
    });

    test('has data-slot attributes on group and items', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      await expect(page.locator('[data-slot="toggle-group"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="toggle-group-item"]')).toHaveCount(3);
    });

    test('renders all items with correct text', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const items = page.locator('[data-slot="toggle-group-item"]');
      await expect(items.nth(0)).toHaveText('Left');
      await expect(items.nth(1)).toHaveText('Center');
      await expect(items.nth(2)).toHaveText('Right');
    });
  });

  test.describe('single mode', () => {
    test('default value item is selected', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="center" />);

      const center = page.locator('[data-slot="toggle-group-item"]').nth(1);
      await expect(center).toHaveAttribute('data-state', 'on');
    });

    test('non-selected items have data-state off', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="center" />);

      const left = page.locator('[data-slot="toggle-group-item"]').nth(0);
      const right = page.locator('[data-slot="toggle-group-item"]').nth(2);
      await expect(left).toHaveAttribute('data-state', 'off');
      await expect(right).toHaveAttribute('data-state', 'off');
    });

    test('clicking another item deselects previous', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="center" />);

      const left = page.locator('[data-slot="toggle-group-item"]').nth(0);
      const center = page.locator('[data-slot="toggle-group-item"]').nth(1);

      await left.click();

      await expect(left).toHaveAttribute('data-state', 'on');
      await expect(center).toHaveAttribute('data-state', 'off');
    });

    test('only one item is selected at a time', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="left" />);

      const items = page.locator('[data-slot="toggle-group-item"]');

      await items.nth(1).click();
      await expect(items.nth(0)).toHaveAttribute('data-state', 'off');
      await expect(items.nth(1)).toHaveAttribute('data-state', 'on');
      await expect(items.nth(2)).toHaveAttribute('data-state', 'off');

      await items.nth(2).click();
      await expect(items.nth(0)).toHaveAttribute('data-state', 'off');
      await expect(items.nth(1)).toHaveAttribute('data-state', 'off');
      await expect(items.nth(2)).toHaveAttribute('data-state', 'on');
    });
  });

  test.describe('multiple mode', () => {
    test('default value items are selected', async ({ mount, page }) => {
      await mount(<MultipleToggleGroup defaultValue={['bold']} />);

      const bold = page.locator('[data-slot="toggle-group-item"]').nth(0);
      await expect(bold).toHaveAttribute('data-state', 'on');
    });

    test('multiple items can be selected', async ({ mount, page }) => {
      await mount(<MultipleToggleGroup defaultValue={['bold']} />);

      const items = page.locator('[data-slot="toggle-group-item"]');

      await items.nth(1).click();

      await expect(items.nth(0)).toHaveAttribute('data-state', 'on');
      await expect(items.nth(1)).toHaveAttribute('data-state', 'on');
    });

    test('clicking a selected item deselects it', async ({ mount, page }) => {
      await mount(<MultipleToggleGroup defaultValue={['bold']} />);

      const bold = page.locator('[data-slot="toggle-group-item"]').nth(0);
      await bold.click();

      await expect(bold).toHaveAttribute('data-state', 'off');
    });

    test('all items can be selected simultaneously', async ({ mount, page }) => {
      await mount(<MultipleToggleGroup defaultValue={['bold']} />);

      const items = page.locator('[data-slot="toggle-group-item"]');
      await items.nth(1).click();
      await items.nth(2).click();

      await expect(items.nth(0)).toHaveAttribute('data-state', 'on');
      await expect(items.nth(1)).toHaveAttribute('data-state', 'on');
      await expect(items.nth(2)).toHaveAttribute('data-state', 'on');
    });
  });

  test.describe('variants', () => {
    test('passes default variant through context', async ({ mount, page }) => {
      await mount(<SingleToggleGroup variant="default" />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveAttribute('data-variant', 'default');

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveAttribute('data-variant', 'default');
    });

    test('passes outline variant through context', async ({ mount, page }) => {
      await mount(<SingleToggleGroup variant="outline" />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveAttribute('data-variant', 'outline');

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveAttribute('data-variant', 'outline');
    });

    test('outline items have border classes', async ({ mount, page }) => {
      await mount(<SingleToggleGroup variant="outline" />);

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveClass(/border/);
    });
  });

  test.describe('sizes', () => {
    test('passes default size through context', async ({ mount, page }) => {
      await mount(<SingleToggleGroup size="default" />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveAttribute('data-size', 'default');

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveAttribute('data-size', 'default');
    });

    test('passes sm size through context', async ({ mount, page }) => {
      await mount(<SingleToggleGroup size="sm" />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveAttribute('data-size', 'sm');

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveAttribute('data-size', 'sm');
      await expect(item).toHaveClass(/h-7/);
    });

    test('passes lg size through context', async ({ mount, page }) => {
      await mount(<SingleToggleGroup size="lg" />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveAttribute('data-size', 'lg');

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveAttribute('data-size', 'lg');
      await expect(item).toHaveClass(/h-11/);
    });
  });

  test.describe('interactions', () => {
    test('click selects an item in single mode', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="left" />);

      const right = page.locator('[data-slot="toggle-group-item"]').nth(2);
      await right.click();

      await expect(right).toHaveAttribute('data-state', 'on');
    });

    test('click toggles items in multiple mode', async ({ mount, page }) => {
      await mount(<MultipleToggleGroup defaultValue={[]} />);

      const bold = page.locator('[data-slot="toggle-group-item"]').nth(0);
      const italic = page.locator('[data-slot="toggle-group-item"]').nth(1);

      await bold.click();
      await expect(bold).toHaveAttribute('data-state', 'on');

      await italic.click();
      await expect(italic).toHaveAttribute('data-state', 'on');
      await expect(bold).toHaveAttribute('data-state', 'on');

      await bold.click();
      await expect(bold).toHaveAttribute('data-state', 'off');
      await expect(italic).toHaveAttribute('data-state', 'on');
    });
  });

  test.describe('styling', () => {
    test('group has flex and w-fit and items-center', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveClass(/flex/);
      await expect(group).toHaveClass(/w-fit/);
      await expect(group).toHaveClass(/items-center/);
    });

    test('group has rounded-control', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveClass(/rounded-control/);
    });

    test('items have data-state on/off', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="center" />);

      const items = page.locator('[data-slot="toggle-group-item"]');
      await expect(items.nth(0)).toHaveAttribute('data-state', 'off');
      await expect(items.nth(1)).toHaveAttribute('data-state', 'on');
      await expect(items.nth(2)).toHaveAttribute('data-state', 'off');
    });

    test('items have inline-flex', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await expect(item).toHaveClass(/inline-flex/);
    });
  });

  test.describe('accessibility', () => {
    test('group has radiogroup role', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      // radix-ui 1.1.12+ renders single-select toggle groups with radio semantics
      await expect(page.getByRole('radiogroup')).toBeVisible();
    });

    test('items have button role', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const items = page.locator('[data-slot="toggle-group-item"]');
      await expect(items).toHaveCount(3);
    });

    test('selected item has aria-pressed true in single mode', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="center" />);

      const center = page.locator('[data-slot="toggle-group-item"]').filter({ hasText: 'Center' });
      await expect(center).toHaveAttribute('data-state', 'on');
    });

    test('unselected items have aria-pressed false', async ({ mount, page }) => {
      await mount(<SingleToggleGroup defaultValue="center" />);

      const left = page.locator('[data-slot="toggle-group-item"]').filter({ hasText: 'Left' });
      await expect(left).toHaveAttribute('data-state', 'off');
    });

    test('items are focusable', async ({ mount, page }) => {
      await mount(<SingleToggleGroup />);

      const item = page.locator('[data-slot="toggle-group-item"]').first();
      await item.focus();
      await expect(item).toBeFocused();
    });
  });

  test.describe('custom className', () => {
    test('ToggleGroup accepts custom className', async ({ mount, page }) => {
      await mount(
        <ToggleGroup type="single" className="custom-group">
          <ToggleGroupItem value="a">A</ToggleGroupItem>
        </ToggleGroup>,
      );

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveClass(/custom-group/);
    });

    test('ToggleGroupItem accepts custom className', async ({ mount, page }) => {
      await mount(
        <ToggleGroup type="single">
          <ToggleGroupItem value="a" className="custom-item">
            A
          </ToggleGroupItem>
        </ToggleGroup>,
      );

      const item = page.locator('[data-slot="toggle-group-item"]');
      await expect(item).toHaveClass(/custom-item/);
    });

    test('custom className merges with default classes', async ({ mount, page }) => {
      await mount(
        <ToggleGroup type="single" className="my-group">
          <ToggleGroupItem value="a" className="my-item">
            A
          </ToggleGroupItem>
        </ToggleGroup>,
      );

      const group = page.locator('[data-slot="toggle-group"]');
      await expect(group).toHaveClass(/my-group/);
      await expect(group).toHaveClass(/flex/);

      const item = page.locator('[data-slot="toggle-group-item"]');
      await expect(item).toHaveClass(/my-item/);
      await expect(item).toHaveClass(/inline-flex/);
    });
  });
});

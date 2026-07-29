import { test, expect } from '@playwright/experimental-ct-react';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemHeader,
  ItemFooter,
} from '../../shadcn/item';

test.describe('Item', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Item>Item content</Item>);
      await expect(component).toBeVisible();
      await expect(component).toHaveText('Item content');
      await expect(component).toHaveAttribute('data-slot', 'item');
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveAttribute('data-size', 'default');
    });

    test('renders as a div element by default', async ({ mount }) => {
      const component = await mount(<Item>Item</Item>);
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('div');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Item className="custom-item">Item</Item>);
      await expect(component).toHaveClass(/custom-item/);
    });

    test('ItemMedia has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemMedia>Media</ItemMedia>);
      await expect(component).toHaveAttribute('data-slot', 'item-media');
    });

    test('ItemContent has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemContent>Content</ItemContent>);
      await expect(component).toHaveAttribute('data-slot', 'item-content');
    });

    test('ItemTitle has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemTitle>Title</ItemTitle>);
      await expect(component).toHaveAttribute('data-slot', 'item-title');
    });

    test('ItemDescription has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemDescription>Description</ItemDescription>);
      await expect(component).toHaveAttribute('data-slot', 'item-description');
    });

    test('ItemActions has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemActions>Actions</ItemActions>);
      await expect(component).toHaveAttribute('data-slot', 'item-actions');
    });

    test('ItemHeader has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemHeader>Header</ItemHeader>);
      await expect(component).toHaveAttribute('data-slot', 'item-header');
    });

    test('ItemFooter has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemFooter>Footer</ItemFooter>);
      await expect(component).toHaveAttribute('data-slot', 'item-footer');
    });

    test('ItemGroup has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemGroup>Group</ItemGroup>);
      await expect(component).toHaveAttribute('data-slot', 'item-group');
    });

    test('ItemSeparator has correct data-slot', async ({ mount }) => {
      const component = await mount(<ItemSeparator />);
      await expect(component).toHaveAttribute('data-slot', 'item-separator');
    });
  });

  test.describe('variants', () => {
    test('renders default variant', async ({ mount }) => {
      const component = await mount(<Item variant="default">Default</Item>);
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveClass(/bg-transparent/);
    });

    test('renders outline variant', async ({ mount }) => {
      const component = await mount(<Item variant="outline">Outline</Item>);
      await expect(component).toHaveAttribute('data-variant', 'outline');
      await expect(component).toHaveClass(/border-border/);
    });

    test('renders muted variant', async ({ mount }) => {
      const component = await mount(<Item variant="muted">Muted</Item>);
      await expect(component).toHaveAttribute('data-variant', 'muted');
    });

    test('ItemMedia renders default variant', async ({ mount }) => {
      const component = await mount(<ItemMedia variant="default">Media</ItemMedia>);
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveClass(/bg-transparent/);
    });

    test('ItemMedia renders icon variant', async ({ mount }) => {
      const component = await mount(
        <ItemMedia variant="icon">
          <svg data-testid="icon" width="16" height="16" />
        </ItemMedia>,
      );
      await expect(component).toHaveAttribute('data-variant', 'icon');
      await expect(component).toHaveClass(/size-8/);
    });

    test('ItemMedia renders image variant', async ({ mount }) => {
      const component = await mount(
        <ItemMedia variant="image">
          <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="test" />
        </ItemMedia>,
      );
      await expect(component).toHaveAttribute('data-variant', 'image');
      await expect(component).toHaveClass(/size-10/);
    });
  });

  test.describe('sizes', () => {
    test('renders default size', async ({ mount }) => {
      const component = await mount(<Item size="default">Default</Item>);
      await expect(component).toHaveAttribute('data-size', 'default');
      await expect(component).toHaveClass(/p-4/);
    });

    test('renders sm size', async ({ mount }) => {
      const component = await mount(<Item size="sm">Small</Item>);
      await expect(component).toHaveAttribute('data-size', 'sm');
      await expect(component).toHaveClass(/py-3/);
    });
  });

  test.describe('composition', () => {
    test('full item structure with all sub-components', async ({ mount }) => {
      const component = await mount(
        <Item>
          <ItemHeader>
            <span>Header text</span>
          </ItemHeader>
          <ItemMedia variant="icon">
            <svg width="16" height="16" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Item Title</ItemTitle>
            <ItemDescription>Item description text</ItemDescription>
          </ItemContent>
          <ItemActions>
            <button>Action</button>
          </ItemActions>
          <ItemFooter>
            <span>Footer text</span>
          </ItemFooter>
        </Item>,
      );

      await expect(component.locator('[data-slot="item-header"]')).toBeVisible();
      await expect(component.locator('[data-slot="item-media"]')).toBeVisible();
      await expect(component.locator('[data-slot="item-content"]')).toBeVisible();
      await expect(component.locator('[data-slot="item-title"]')).toHaveText('Item Title');
      await expect(component.locator('[data-slot="item-description"]')).toHaveText('Item description text');
      await expect(component.locator('[data-slot="item-actions"]')).toBeVisible();
      await expect(component.locator('[data-slot="item-footer"]')).toBeVisible();
    });

    test('ItemGroup with multiple items', async ({ mount }) => {
      const component = await mount(
        <ItemGroup>
          <Item>First</Item>
          <ItemSeparator />
          <Item>Second</Item>
        </ItemGroup>,
      );

      const items = component.locator('[data-slot="item"]');
      await expect(items).toHaveCount(2);
      const separator = component.locator('[data-slot="item-separator"]');
      await expect(separator).toHaveCount(1);
    });

    test('renders as child element when asChild is true', async ({ mount }) => {
      const component = await mount(
        <Item asChild>
          <a href="https://example.com">Link Item</a>
        </Item>,
      );
      await expect(component).toHaveRole('link');
      await expect(component).toHaveAttribute('href', 'https://example.com');
    });
  });

  test.describe('accessibility', () => {
    test('ItemGroup has role="list"', async ({ mount }) => {
      const component = await mount(
        <ItemGroup>
          <Item>Item</Item>
        </ItemGroup>,
      );
      await expect(component).toHaveRole('list');
    });

    test('ItemMedia applies custom className', async ({ mount }) => {
      const component = await mount(<ItemMedia className="custom-media">Media</ItemMedia>);
      await expect(component).toHaveClass(/custom-media/);
    });

    test('ItemContent applies custom className', async ({ mount }) => {
      const component = await mount(<ItemContent className="custom-content">Content</ItemContent>);
      await expect(component).toHaveClass(/custom-content/);
    });

    test('ItemTitle applies custom className', async ({ mount }) => {
      const component = await mount(<ItemTitle className="custom-title">Title</ItemTitle>);
      await expect(component).toHaveClass(/custom-title/);
    });

    test('ItemDescription applies custom className', async ({ mount }) => {
      const component = await mount(<ItemDescription className="custom-desc">Description</ItemDescription>);
      await expect(component).toHaveClass(/custom-desc/);
    });

    test('ItemActions applies custom className', async ({ mount }) => {
      const component = await mount(<ItemActions className="custom-actions">Actions</ItemActions>);
      await expect(component).toHaveClass(/custom-actions/);
    });

    test('ItemHeader applies custom className', async ({ mount }) => {
      const component = await mount(<ItemHeader className="custom-header">Header</ItemHeader>);
      await expect(component).toHaveClass(/custom-header/);
    });

    test('ItemFooter applies custom className', async ({ mount }) => {
      const component = await mount(<ItemFooter className="custom-footer">Footer</ItemFooter>);
      await expect(component).toHaveClass(/custom-footer/);
    });
  });
});

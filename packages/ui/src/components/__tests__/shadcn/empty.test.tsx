import { test, expect } from '@playwright/experimental-ct-react';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from '../../shadcn/empty';

test.describe('Empty', () => {
  test.describe('Empty (root)', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<Empty>Empty state</Empty>);
      await expect(component).toBeVisible();
      await expect(component).toHaveAttribute('data-slot', 'empty');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Empty className="custom-empty">Content</Empty>);
      await expect(component).toHaveClass(/custom-empty/);
    });

    test('has correct default styling', async ({ mount }) => {
      const component = await mount(<Empty>Content</Empty>);
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/flex-col/);
      await expect(component).toHaveClass(/items-center/);
      await expect(component).toHaveClass(/justify-center/);
      await expect(component).toHaveClass(/border-dashed/);
    });

    test('renders children', async ({ mount }) => {
      const component = await mount(
        <Empty>
          <span data-testid="child">Child element</span>
        </Empty>,
      );
      const child = component.locator('[data-testid="child"]');
      await expect(child).toBeVisible();
      await expect(child).toHaveText('Child element');
    });
  });

  test.describe('EmptyHeader', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<EmptyHeader>Header</EmptyHeader>);
      await expect(component).toHaveAttribute('data-slot', 'empty-header');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<EmptyHeader className="custom-header">Header</EmptyHeader>);
      await expect(component).toHaveClass(/custom-header/);
    });

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(<EmptyHeader>Header</EmptyHeader>);
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/flex-col/);
      await expect(component).toHaveClass(/items-center/);
    });
  });

  test.describe('EmptyMedia', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <EmptyMedia>
          <svg />
        </EmptyMedia>,
      );
      await expect(component).toHaveAttribute('data-slot', 'empty-icon');
    });

    test('renders default variant', async ({ mount }) => {
      const component = await mount(
        <EmptyMedia>
          <svg />
        </EmptyMedia>,
      );
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveClass(/bg-transparent/);
    });

    test('renders icon variant', async ({ mount }) => {
      const component = await mount(
        <EmptyMedia variant="icon">
          <svg />
        </EmptyMedia>,
      );
      await expect(component).toHaveAttribute('data-variant', 'icon');
      await expect(component).toHaveClass(/bg-muted/);
      await expect(component).toHaveClass(/rounded-lg/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <EmptyMedia className="custom-media">
          <svg />
        </EmptyMedia>,
      );
      await expect(component).toHaveClass(/custom-media/);
    });
  });

  test.describe('EmptyTitle', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<EmptyTitle>Title</EmptyTitle>);
      await expect(component).toHaveAttribute('data-slot', 'empty-title');
    });

    test('renders text content', async ({ mount }) => {
      const component = await mount(<EmptyTitle>No results found</EmptyTitle>);
      await expect(component).toHaveText('No results found');
    });

    test('has correct font styling', async ({ mount }) => {
      const component = await mount(<EmptyTitle>Title</EmptyTitle>);
      await expect(component).toHaveClass(/text-lg/);
      await expect(component).toHaveClass(/font-medium/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<EmptyTitle className="custom-title">Title</EmptyTitle>);
      await expect(component).toHaveClass(/custom-title/);
    });
  });

  test.describe('EmptyDescription', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<EmptyDescription>Description</EmptyDescription>);
      await expect(component).toHaveAttribute('data-slot', 'empty-description');
    });

    test('renders text content', async ({ mount }) => {
      const component = await mount(<EmptyDescription>Try adjusting your search</EmptyDescription>);
      await expect(component).toHaveText('Try adjusting your search');
    });

    test('has muted text styling', async ({ mount }) => {
      const component = await mount(<EmptyDescription>Description</EmptyDescription>);
      await expect(component).toHaveClass(/text-muted-foreground/);
      await expect(component).toHaveClass(/text-sm/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<EmptyDescription className="custom-desc">Desc</EmptyDescription>);
      await expect(component).toHaveClass(/custom-desc/);
    });
  });

  test.describe('EmptyContent', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<EmptyContent>Content</EmptyContent>);
      await expect(component).toHaveAttribute('data-slot', 'empty-content');
    });

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(<EmptyContent>Content</EmptyContent>);
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/flex-col/);
      await expect(component).toHaveClass(/items-center/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<EmptyContent className="custom-content">Content</EmptyContent>);
      await expect(component).toHaveClass(/custom-content/);
    });
  });

  test.describe('full composition', () => {
    test('renders complete empty state structure', async ({ mount, page }) => {
      await mount(
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <svg data-testid="icon" />
            </EmptyMedia>
            <EmptyTitle>No items found</EmptyTitle>
            <EmptyDescription>There are no items to display right now.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <button>Create Item</button>
          </EmptyContent>
        </Empty>,
      );

      await expect(page.locator('[data-slot="empty"]')).toBeVisible();
      await expect(page.locator('[data-slot="empty-header"]')).toBeVisible();
      await expect(page.locator('[data-slot="empty-icon"]')).toBeVisible();
      await expect(page.locator('[data-slot="empty-title"]')).toHaveText('No items found');
      await expect(page.locator('[data-slot="empty-description"]')).toHaveText('There are no items to display right now.');
      await expect(page.locator('[data-slot="empty-content"]')).toBeVisible();
    });

    test('maintains proper nesting structure', async ({ mount, page }) => {
      await mount(
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Title</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>Action area</EmptyContent>
        </Empty>,
      );

      const empty = page.locator('[data-slot="empty"]');
      const header = empty.locator('[data-slot="empty-header"]');
      const title = header.locator('[data-slot="empty-title"]');

      await expect(empty).toBeVisible();
      await expect(header).toBeVisible();
      await expect(title).toBeVisible();
    });
  });
});

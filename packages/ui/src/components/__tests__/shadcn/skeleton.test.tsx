import { test, expect } from '@playwright/experimental-ct-react';
import { Skeleton } from '../../shadcn/skeleton';

test.describe('Skeleton', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Skeleton className="h-4 w-full" />);
      await expect(component).toBeVisible();
      await expect(component).toHaveAttribute('data-slot', 'skeleton');
    });

    test('renders as a div element', async ({ mount }) => {
      const component = await mount(<Skeleton />);
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('div');
    });
  });

  test.describe('styling', () => {
    test('has animate-pulse class', async ({ mount }) => {
      const component = await mount(<Skeleton />);
      await expect(component).toHaveClass(/animate-pulse/);
    });

    test('has rounded-md class', async ({ mount }) => {
      const component = await mount(<Skeleton />);
      await expect(component).toHaveClass(/rounded-md/);
    });

    test('has bg-accent class', async ({ mount }) => {
      const component = await mount(<Skeleton />);
      await expect(component).toHaveClass(/bg-accent/);
    });

    test('has all default classes together', async ({ mount }) => {
      const component = await mount(<Skeleton />);
      await expect(component).toHaveClass(/bg-accent/);
      await expect(component).toHaveClass(/animate-pulse/);
      await expect(component).toHaveClass(/rounded-md/);
    });
  });

  test.describe('custom className', () => {
    test('accepts and merges custom className', async ({ mount }) => {
      const component = await mount(<Skeleton className="h-4 w-[200px]" />);
      await expect(component).toHaveClass(/h-4/);
      await expect(component).toHaveClass(/animate-pulse/);
      await expect(component).toHaveClass(/rounded-md/);
    });

    test('accepts width and height classes', async ({ mount }) => {
      const component = await mount(<Skeleton className="h-12 w-12 rounded-full" />);
      await expect(component).toHaveClass(/h-12/);
      await expect(component).toHaveClass(/w-12/);
      await expect(component).toHaveClass(/rounded-full/);
    });

    test('preserves data-slot with custom className', async ({ mount }) => {
      const component = await mount(<Skeleton className="custom-skeleton" />);
      await expect(component).toHaveAttribute('data-slot', 'skeleton');
      await expect(component).toHaveClass(/custom-skeleton/);
    });
  });

  test.describe('composition', () => {
    test('renders children if provided', async ({ mount }) => {
      const component = await mount(
        <Skeleton>
          <span>Loading text</span>
        </Skeleton>,
      );
      await expect(component).toContainText('Loading text');
    });

    test('skeleton card layout', async ({ mount }) => {
      const component = await mount(
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[125px] w-[250px] rounded-xl" />
          <Skeleton className="h-4 w-[250px]" />
          <Skeleton className="h-4 w-[200px]" />
        </div>,
      );

      const skeletons = component.locator('[data-slot="skeleton"]');
      await expect(skeletons).toHaveCount(3);
    });

    test('avatar skeleton with circular shape', async ({ mount }) => {
      const component = await mount(<Skeleton className="h-12 w-12 rounded-full" />);
      await expect(component).toHaveClass(/rounded-full/);
      await expect(component).toHaveAttribute('data-slot', 'skeleton');
    });
  });

  test.describe('accessibility', () => {
    test('supports aria-label for loading indication', async ({ mount }) => {
      const component = await mount(<Skeleton aria-label="Loading content" />);
      await expect(component).toHaveAttribute('aria-label', 'Loading content');
    });

    test('supports aria-busy attribute', async ({ mount }) => {
      const component = await mount(<Skeleton aria-busy="true" />);
      await expect(component).toHaveAttribute('aria-busy', 'true');
    });

    test('supports role attribute', async ({ mount }) => {
      const component = await mount(<Skeleton role="progressbar" aria-label="Loading" />);
      await expect(component).toHaveRole('progressbar');
    });
  });
});

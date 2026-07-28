import { test, expect } from '@playwright/experimental-ct-react';
import { Separator } from '../../shadcn/separator';

test.describe('Separator', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Separator />);
      await expect(component).toBeVisible();
      await expect(component).toHaveAttribute('data-slot', 'separator');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Separator className="custom-sep" />);
      await expect(component).toHaveClass(/custom-sep/);
    });
  });

  test.describe('orientation', () => {
    test('renders horizontal by default', async ({ mount }) => {
      const component = await mount(<Separator />);
      await expect(component).toHaveAttribute('data-orientation', 'horizontal');
    });

    test('renders horizontal orientation explicitly', async ({ mount }) => {
      const component = await mount(<Separator orientation="horizontal" />);
      await expect(component).toHaveAttribute('data-orientation', 'horizontal');
    });

    test('renders vertical orientation', async ({ mount }) => {
      const component = await mount(
        <div style={{ height: '100px', display: 'flex' }}>
          <Separator orientation="vertical" />
        </div>,
      );
      const separator = component.locator('[data-slot="separator"]');
      await expect(separator).toHaveAttribute('data-orientation', 'vertical');
    });
  });

  test.describe('styling', () => {
    test('has bg-border class', async ({ mount }) => {
      const component = await mount(<Separator />);
      await expect(component).toHaveClass(/bg-border/);
    });

    test('has shrink-0 class', async ({ mount }) => {
      const component = await mount(<Separator />);
      await expect(component).toHaveClass(/shrink-0/);
    });

    test('horizontal has h-px and w-full via data attribute styles', async ({ mount }) => {
      const component = await mount(<Separator orientation="horizontal" />);
      await expect(component).toHaveClass(/data-\[orientation=horizontal\]:h-px/);
      await expect(component).toHaveClass(/data-\[orientation=horizontal\]:w-full/);
    });

    test('vertical has h-full and w-px via data attribute styles', async ({ mount }) => {
      const component = await mount(
        <div style={{ height: '100px', display: 'flex' }}>
          <Separator orientation="vertical" />
        </div>,
      );
      const separator = component.locator('[data-slot="separator"]');
      await expect(separator).toHaveClass(/data-\[orientation=vertical\]:h-full/);
      await expect(separator).toHaveClass(/data-\[orientation=vertical\]:w-px/);
    });
  });

  test.describe('decorative', () => {
    test('is decorative by default', async ({ mount }) => {
      const component = await mount(<Separator />);
      await expect(component).toHaveRole('none');
    });

    test('has role="none" when decorative is true', async ({ mount }) => {
      const component = await mount(<Separator decorative={true} />);
      await expect(component).toHaveRole('none');
    });

    test('has role="separator" when decorative is false', async ({ mount }) => {
      const component = await mount(<Separator decorative={false} />);
      await expect(component).toHaveRole('separator');
    });
  });

  test.describe('accessibility', () => {
    test('non-decorative separator has role="separator"', async ({ mount }) => {
      const component = await mount(<Separator decorative={false} />);
      await expect(component).toHaveRole('separator');
    });

    test('decorative separator has role="none"', async ({ mount }) => {
      const component = await mount(<Separator decorative={true} />);
      await expect(component).toHaveRole('none');
    });

    test('non-decorative separator exposes orientation to assistive tech', async ({ mount }) => {
      const component = await mount(<Separator decorative={false} orientation="horizontal" />);
      await expect(component).toHaveRole('separator');
      await expect(component).toHaveAttribute('data-orientation', 'horizontal');
    });

    test('supports aria-label on non-decorative separator', async ({ mount }) => {
      const component = await mount(<Separator decorative={false} aria-label="Content divider" />);
      await expect(component).toHaveAttribute('aria-label', 'Content divider');
    });
  });

  test.describe('composition', () => {
    test('separates content sections', async ({ mount }) => {
      const component = await mount(
        <div>
          <p>Section 1</p>
          <Separator />
          <p>Section 2</p>
        </div>,
      );

      const separator = component.locator('[data-slot="separator"]');
      await expect(separator).toHaveCount(1);
      await expect(component).toContainText('Section 1');
      await expect(component).toContainText('Section 2');
    });

    test('multiple separators render independently', async ({ mount }) => {
      const component = await mount(
        <div>
          <Separator />
          <Separator />
          <Separator />
        </div>,
      );

      const separators = component.locator('[data-slot="separator"]');
      await expect(separators).toHaveCount(3);
    });
  });
});

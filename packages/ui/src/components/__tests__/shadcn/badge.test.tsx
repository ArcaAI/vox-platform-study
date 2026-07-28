import { test, expect } from '@playwright/experimental-ct-react';
import { Badge } from '../../shadcn/badge';

test.describe('Badge', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Badge>Badge text</Badge>);
      await expect(component).toBeVisible();
      await expect(component).toHaveText('Badge text');
      await expect(component).toHaveAttribute('data-slot', 'badge');
      await expect(component).toHaveAttribute('data-variant', 'default');
    });

    test('renders as a span element by default', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('span');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Badge className="custom-badge">Badge</Badge>);
      await expect(component).toHaveClass(/custom-badge/);
    });

    test('has pill shape (rounded-full)', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      await expect(component).toHaveClass(/rounded-full/);
    });
  });

  test.describe('variants', () => {
    test('renders default variant', async ({ mount }) => {
      const component = await mount(<Badge variant="default">Default</Badge>);
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveClass(/bg-primary/);
    });

    test('renders secondary variant', async ({ mount }) => {
      const component = await mount(<Badge variant="secondary">Secondary</Badge>);
      await expect(component).toHaveAttribute('data-variant', 'secondary');
      await expect(component).toHaveClass(/bg-secondary/);
    });

    test('renders destructive variant', async ({ mount }) => {
      const component = await mount(<Badge variant="destructive">Destructive</Badge>);
      await expect(component).toHaveAttribute('data-variant', 'destructive');
      await expect(component).toHaveClass(/bg-destructive/);
    });

    test('renders outline variant', async ({ mount }) => {
      const component = await mount(<Badge variant="outline">Outline</Badge>);
      await expect(component).toHaveAttribute('data-variant', 'outline');
      await expect(component).toHaveClass(/border-border/);
    });

    test('renders ghost variant', async ({ mount }) => {
      const component = await mount(<Badge variant="ghost">Ghost</Badge>);
      await expect(component).toHaveAttribute('data-variant', 'ghost');
    });

    test('renders link variant', async ({ mount }) => {
      const component = await mount(<Badge variant="link">Link</Badge>);
      await expect(component).toHaveAttribute('data-variant', 'link');
      await expect(component).toHaveClass(/underline-offset-4/);
    });
  });

  test.describe('asChild prop', () => {
    test('renders as anchor when asChild is true', async ({ mount }) => {
      const component = await mount(
        <Badge asChild>
          <a href="https://example.com">Link Badge</a>
        </Badge>,
      );
      await expect(component).toHaveRole('link');
      await expect(component).toHaveAttribute('href', 'https://example.com');
    });

    test('preserves badge styling when rendered as link', async ({ mount }) => {
      const component = await mount(
        <Badge asChild variant="outline">
          <a href="#">Styled Link Badge</a>
        </Badge>,
      );
      await expect(component).toHaveClass(/rounded-full/);
      await expect(component).toHaveClass(/border-border/);
    });

    test('renders as button when asChild is true', async ({ mount }) => {
      const component = await mount(
        <Badge asChild>
          <button type="button">Button Badge</button>
        </Badge>,
      );
      await expect(component).toHaveRole('button');
    });
  });

  test.describe('with icons', () => {
    test('renders badge with icon', async ({ mount }) => {
      const component = await mount(
        <Badge>
          <svg data-testid="icon" width="12" height="12" />
          With Icon
        </Badge>,
      );
      const icon = component.locator('[data-testid="icon"]');
      await expect(icon).toBeVisible();
      await expect(component).toContainText('With Icon');
    });

    test('applies icon sizing', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      // The component has [&>svg]:size-3 class
      await expect(component).toHaveClass(/\[&>svg\]:size-3/);
    });
  });

  test.describe('interactions', () => {
    test('badge as link is clickable', async ({ mount }) => {
      let clicked = false;
      const component = await mount(
        <Badge asChild>
          <a href="#" onClick={() => (clicked = true)}>
            Clickable Badge
          </a>
        </Badge>,
      );
      await component.click();
      expect(clicked).toBe(true);
    });

    test('badge as button handles click', async ({ mount }) => {
      let clicked = false;
      const component = await mount(
        <Badge asChild>
          <button onClick={() => (clicked = true)}>Button Badge</button>
        </Badge>,
      );
      await component.click();
      expect(clicked).toBe(true);
    });
  });

  test.describe('styling', () => {
    test('has inline-flex display', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      await expect(component).toHaveClass(/inline-flex/);
    });

    test('has centered content', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      await expect(component).toHaveClass(/items-center/);
      await expect(component).toHaveClass(/justify-center/);
    });

    test('has appropriate font styling', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      await expect(component).toHaveClass(/text-xs/);
      await expect(component).toHaveClass(/font-medium/);
    });

    test('has width fit-content', async ({ mount }) => {
      const component = await mount(<Badge>Badge</Badge>);
      await expect(component).toHaveClass(/w-fit/);
    });

    test('prevents text wrapping', async ({ mount }) => {
      const component = await mount(<Badge>Long badge text here</Badge>);
      await expect(component).toHaveClass(/whitespace-nowrap/);
    });
  });

  test.describe('accessibility', () => {
    test('has accessible text content', async ({ mount }) => {
      const component = await mount(<Badge>Status: Active</Badge>);
      await expect(component).toHaveText('Status: Active');
    });

    test('supports aria attributes', async ({ mount }) => {
      const component = await mount(<Badge aria-label="5 notifications">5</Badge>);
      await expect(component).toHaveAttribute('aria-label', '5 notifications');
    });

    test('badge as link has accessible name', async ({ mount }) => {
      const component = await mount(
        <Badge asChild>
          <a href="#">View details</a>
        </Badge>,
      );
      await expect(component).toHaveAccessibleName('View details');
    });

    test('supports focus-visible styling', async ({ mount }) => {
      const component = await mount(
        <Badge asChild>
          <button>Focusable</button>
        </Badge>,
      );
      await expect(component).toHaveClass(/focus-visible:ring/);
    });

    test('supports aria-invalid state', async ({ mount }) => {
      const component = await mount(<Badge aria-invalid="true">Invalid</Badge>);
      await expect(component).toHaveAttribute('aria-invalid', 'true');
      await expect(component).toHaveClass(/aria-invalid:border-destructive/);
    });
  });

  test.describe('composition', () => {
    test('multiple badges render independently', async ({ mount }) => {
      const component = await mount(
        <div>
          <Badge variant="default">Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>,
      );

      const badges = component.locator('[data-slot="badge"]');
      await expect(badges).toHaveCount(3);
    });

    test('badge within other components', async ({ mount }) => {
      const component = await mount(
        <button>
          Notifications <Badge>5</Badge>
        </button>,
      );

      const badge = component.locator('[data-slot="badge"]');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('5');
    });
  });
});

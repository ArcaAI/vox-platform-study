import { test, expect } from '@playwright/experimental-ct-react';
import { Button } from '../../shadcn/button';

test.describe('Button', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Button>Click me</Button>);
      await expect(component).toBeVisible();
      await expect(component).toHaveText('Click me');
      await expect(component).toHaveAttribute('data-slot', 'button');
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveAttribute('data-size', 'default');
    });

    test('renders as a button element by default', async ({ mount }) => {
      const component = await mount(<Button>Button</Button>);
      await expect(component).toHaveRole('button');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Button className="custom-class">Button</Button>);
      await expect(component).toHaveClass(/custom-class/);
    });
  });

  test.describe('variants', () => {
    test('renders default variant', async ({ mount }) => {
      const component = await mount(<Button variant="default">Default</Button>);
      await expect(component).toHaveAttribute('data-variant', 'default');
      await expect(component).toHaveClass(/bg-primary/);
    });

    test('renders destructive variant', async ({ mount }) => {
      const component = await mount(<Button variant="destructive">Destructive</Button>);
      await expect(component).toHaveAttribute('data-variant', 'destructive');
      await expect(component).toHaveClass(/bg-destructive/);
    });

    test('renders outline variant', async ({ mount }) => {
      const component = await mount(<Button variant="outline">Outline</Button>);
      await expect(component).toHaveAttribute('data-variant', 'outline');
      await expect(component).toHaveClass(/border/);
    });

    test('renders secondary variant', async ({ mount }) => {
      const component = await mount(<Button variant="secondary">Secondary</Button>);
      await expect(component).toHaveAttribute('data-variant', 'secondary');
      await expect(component).toHaveClass(/bg-secondary/);
    });

    test('renders ghost variant', async ({ mount }) => {
      const component = await mount(<Button variant="ghost">Ghost</Button>);
      await expect(component).toHaveAttribute('data-variant', 'ghost');
    });

    test('renders link variant', async ({ mount }) => {
      const component = await mount(<Button variant="link">Link</Button>);
      await expect(component).toHaveAttribute('data-variant', 'link');
      await expect(component).toHaveClass(/underline-offset-4/);
    });
  });

  test.describe('sizes', () => {
    test('renders default size', async ({ mount }) => {
      const component = await mount(<Button size="default">Default</Button>);
      await expect(component).toHaveAttribute('data-size', 'default');
      await expect(component).toHaveClass(/h-9/);
    });

    test('renders xs size', async ({ mount }) => {
      const component = await mount(<Button size="xs">Extra Small</Button>);
      await expect(component).toHaveAttribute('data-size', 'xs');
      await expect(component).toHaveClass(/h-6/);
    });

    test('renders sm size', async ({ mount }) => {
      const component = await mount(<Button size="sm">Small</Button>);
      await expect(component).toHaveAttribute('data-size', 'sm');
      await expect(component).toHaveClass(/h-8/);
    });

    test('renders lg size', async ({ mount }) => {
      const component = await mount(<Button size="lg">Large</Button>);
      await expect(component).toHaveAttribute('data-size', 'lg');
      await expect(component).toHaveClass(/h-10/);
    });

    test('renders icon size', async ({ mount }) => {
      const component = await mount(
        <Button size="icon">
          <span>X</span>
        </Button>,
      );
      await expect(component).toHaveAttribute('data-size', 'icon');
      await expect(component).toHaveClass(/size-9/);
    });

    test('renders icon-xs size', async ({ mount }) => {
      const component = await mount(
        <Button size="icon-xs">
          <span>X</span>
        </Button>,
      );
      await expect(component).toHaveAttribute('data-size', 'icon-xs');
      await expect(component).toHaveClass(/size-6/);
    });

    test('renders icon-sm size', async ({ mount }) => {
      const component = await mount(
        <Button size="icon-sm">
          <span>X</span>
        </Button>,
      );
      await expect(component).toHaveAttribute('data-size', 'icon-sm');
      await expect(component).toHaveClass(/size-8/);
    });

    test('renders icon-lg size', async ({ mount }) => {
      const component = await mount(
        <Button size="icon-lg">
          <span>X</span>
        </Button>,
      );
      await expect(component).toHaveAttribute('data-size', 'icon-lg');
      await expect(component).toHaveClass(/size-10/);
    });
  });

  test.describe('states', () => {
    test('handles disabled state', async ({ mount }) => {
      const component = await mount(<Button disabled>Disabled</Button>);
      await expect(component).toBeDisabled();
      await expect(component).toHaveClass(/disabled:opacity-50/);
    });

    test('is focusable when enabled', async ({ mount, page }) => {
      const component = await mount(<Button>Focusable</Button>);
      await component.focus();
      await expect(component).toBeFocused();
    });

    test('is not focusable when disabled', async ({ mount }) => {
      const component = await mount(<Button disabled>Not Focusable</Button>);
      await component.focus();
      await expect(component).not.toBeFocused();
    });
  });

  test.describe('interactions', () => {
    test('handles click events', async ({ mount }) => {
      let clicked = false;
      const component = await mount(<Button onClick={() => (clicked = true)}>Click me</Button>);
      await component.click();
      expect(clicked).toBe(true);
    });

    test('does not trigger click when disabled', async ({ mount }) => {
      let clicked = false;
      const component = await mount(
        <Button disabled onClick={() => (clicked = true)}>
          Disabled
        </Button>,
      );
      await component.click({ force: true });
      expect(clicked).toBe(false);
    });

    test('handles keyboard activation with Enter', async ({ mount }) => {
      let clicked = false;
      const component = await mount(<Button onClick={() => (clicked = true)}>Press Enter</Button>);
      await component.focus();
      await component.press('Enter');
      expect(clicked).toBe(true);
    });

    test('handles keyboard activation with Space', async ({ mount }) => {
      let clicked = false;
      const component = await mount(<Button onClick={() => (clicked = true)}>Press Space</Button>);
      await component.focus();
      await component.press(' ');
      expect(clicked).toBe(true);
    });
  });

  test.describe('asChild prop', () => {
    test('renders as a child element when asChild is true', async ({ mount }) => {
      const component = await mount(
        <Button asChild>
          <a href="https://example.com">Link Button</a>
        </Button>,
      );
      await expect(component).toHaveRole('link');
      await expect(component).toHaveAttribute('href', 'https://example.com');
    });

    test('preserves button styling when rendered as link', async ({ mount }) => {
      const component = await mount(
        <Button asChild variant="outline">
          <a href="#">Styled Link</a>
        </Button>,
      );
      await expect(component).toHaveClass(/border/);
    });
  });

  test.describe('accessibility', () => {
    test('has accessible name from children', async ({ mount }) => {
      const component = await mount(<Button>Accessible Button</Button>);
      await expect(component).toHaveAccessibleName('Accessible Button');
    });

    test('supports aria-label', async ({ mount }) => {
      const component = await mount(
        <Button aria-label="Custom label">
          <span>X</span>
        </Button>,
      );
      await expect(component).toHaveAccessibleName('Custom label');
    });

    test('supports aria-describedby', async ({ mount }) => {
      const component = await mount(
        <div>
          <Button aria-describedby="description">Button</Button>
          <span id="description">This is a description</span>
        </div>,
      );
      const button = component.getByRole('button');
      await expect(button).toHaveAttribute('aria-describedby', 'description');
    });

    test('indicates disabled state to assistive technologies', async ({ mount }) => {
      const component = await mount(<Button disabled>Disabled Button</Button>);
      await expect(component).toBeDisabled();
    });
  });
});

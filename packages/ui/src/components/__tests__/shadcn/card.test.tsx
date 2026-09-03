import { test, expect } from '@playwright/experimental-ct-react';
import { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent } from '../../shadcn/card';

test.describe('Card', () => {
  test.describe('Card (root)', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Card>Card content</Card>);
      await expect(component).toBeVisible();
      await expect(component).toHaveText('Card content');
      await expect(component).toHaveAttribute('data-slot', 'card');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Card className="custom-card">Content</Card>);
      await expect(component).toHaveClass(/custom-card/);
    });

    test('has correct default styling', async ({ mount }) => {
      const component = await mount(<Card>Content</Card>);
      await expect(component).toHaveClass(/rounded-surface/);
      await expect(component).toHaveClass(/border/);
      // cards are flat — depth is border + surface, never elevation.
      await expect(component).not.toHaveClass(/shadow-(xs|sm|md|lg|xl|raised|overlay)/);
    });

    test('renders children correctly', async ({ mount }) => {
      const component = await mount(
        <Card>
          <span data-testid="child">Child element</span>
        </Card>,
      );
      const child = component.locator('[data-testid="child"]');
      await expect(child).toBeVisible();
      await expect(child).toHaveText('Child element');
    });
  });

  test.describe('CardHeader', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<CardHeader>Header</CardHeader>);
      await expect(component).toHaveAttribute('data-slot', 'card-header');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<CardHeader className="custom-header">Header</CardHeader>);
      await expect(component).toHaveClass(/custom-header/);
    });

    test('renders within Card', async ({ mount }) => {
      const component = await mount(
        <Card>
          <CardHeader>Header content</CardHeader>
        </Card>,
      );
      const header = component.locator('[data-slot="card-header"]');
      await expect(header).toBeVisible();
      await expect(header).toHaveText('Header content');
    });
  });

  test.describe('CardTitle', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<CardTitle>Title</CardTitle>);
      await expect(component).toHaveAttribute('data-slot', 'card-title');
    });

    test('applies font styling', async ({ mount }) => {
      const component = await mount(<CardTitle>Title</CardTitle>);
      await expect(component).toHaveClass(/font-medium/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<CardTitle className="text-2xl">Large Title</CardTitle>);
      await expect(component).toHaveClass(/text-2xl/);
    });
  });

  test.describe('CardDescription', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<CardDescription>Description</CardDescription>);
      await expect(component).toHaveAttribute('data-slot', 'card-description');
    });

    test('applies muted text styling', async ({ mount }) => {
      const component = await mount(<CardDescription>Description</CardDescription>);
      await expect(component).toHaveClass(/text-muted-foreground/);
      await expect(component).toHaveClass(/text-sm/);
    });
  });

  test.describe('CardAction', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<CardAction>Action</CardAction>);
      await expect(component).toHaveAttribute('data-slot', 'card-action');
    });

    test('positions correctly in grid', async ({ mount }) => {
      const component = await mount(<CardAction>Action</CardAction>);
      await expect(component).toHaveClass(/col-start-2/);
      await expect(component).toHaveClass(/row-span-2/);
    });
  });

  test.describe('CardContent', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<CardContent>Content</CardContent>);
      await expect(component).toHaveAttribute('data-slot', 'card-content');
    });

    test('applies padding', async ({ mount }) => {
      const component = await mount(<CardContent>Content</CardContent>);
      await expect(component).toHaveClass(/px-6/);
    });

    test('renders complex content', async ({ mount }) => {
      const component = await mount(
        <CardContent>
          <p>Paragraph 1</p>
          <p>Paragraph 2</p>
        </CardContent>,
      );
      await expect(component).toContainText('Paragraph 1');
      await expect(component).toContainText('Paragraph 2');
    });
  });

  test.describe('CardFooter', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<CardFooter>Footer</CardFooter>);
      await expect(component).toHaveAttribute('data-slot', 'card-footer');
    });

    test('applies flex layout', async ({ mount }) => {
      const component = await mount(<CardFooter>Footer</CardFooter>);
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/items-center/);
    });
  });

  test.describe('Full Card composition', () => {
    test('renders complete card structure', async ({ mount, page }) => {
      await mount(
        <Card>
          <CardHeader>
            <CardTitle>Card Title</CardTitle>
            <CardDescription>Card description text</CardDescription>
            <CardAction>
              <button>Action</button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p>Main content goes here</p>
          </CardContent>
          <CardFooter>
            <button>Footer button</button>
          </CardFooter>
        </Card>,
      );

      await expect(page.locator('[data-slot="card"]')).toBeVisible();
      await expect(page.locator('[data-slot="card-header"]')).toBeVisible();
      await expect(page.locator('[data-slot="card-title"]')).toHaveText('Card Title');
      await expect(page.locator('[data-slot="card-description"]')).toHaveText('Card description text');
      await expect(page.locator('[data-slot="card-action"]')).toBeVisible();
      await expect(page.locator('[data-slot="card-content"]')).toHaveText('Main content goes here');
      await expect(page.locator('[data-slot="card-footer"]')).toBeVisible();
    });

    test('maintains proper nesting structure', async ({ mount, page }) => {
      await mount(
        <Card>
          <CardHeader>
            <CardTitle>Title</CardTitle>
          </CardHeader>
          <CardContent>Content</CardContent>
        </Card>,
      );

      const card = page.locator('[data-slot="card"]');
      const header = card.locator('[data-slot="card-header"]');
      const title = header.locator('[data-slot="card-title"]');

      await expect(card).toBeVisible();
      await expect(header).toBeVisible();
      await expect(title).toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('card structure is accessible', async ({ mount }) => {
      const component = await mount(
        <Card role="article" aria-labelledby="card-title">
          <CardHeader>
            <CardTitle id="card-title">Accessible Card</CardTitle>
          </CardHeader>
          <CardContent>Content</CardContent>
        </Card>,
      );

      await expect(component).toHaveRole('article');
      await expect(component).toHaveAttribute('aria-labelledby', 'card-title');
    });

    test('interactive elements within card are focusable', async ({ mount }) => {
      const component = await mount(
        <Card>
          <CardContent>
            <button>Focusable button</button>
          </CardContent>
        </Card>,
      );

      const button = component.getByRole('button');
      await button.focus();
      await expect(button).toBeFocused();
    });
  });
});

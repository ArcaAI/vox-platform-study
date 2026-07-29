import { test, expect } from '@playwright/experimental-ct-react';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from '../../shadcn/breadcrumb';

test.describe('Breadcrumb', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      await expect(component).toHaveAttribute('data-slot', 'breadcrumb');
    });

    test('renders as nav element', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      await expect(component).toHaveRole('navigation');
    });

    test('has aria-label breadcrumb', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      await expect(component).toHaveAttribute('aria-label', 'breadcrumb');
    });

    test('renders full breadcrumb composition', async ({ mount, page }) => {
      await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/products">Products</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Current Page</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );

      await expect(page.locator('[data-slot="breadcrumb"]')).toBeVisible();
      await expect(page.locator('[data-slot="breadcrumb-list"]')).toBeVisible();
      await expect(page.locator('[data-slot="breadcrumb-item"]')).toHaveCount(3);
      await expect(page.locator('[data-slot="breadcrumb-separator"]')).toHaveCount(2);
    });
  });

  test.describe('BreadcrumbList', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const list = component.locator('[data-slot="breadcrumb-list"]');
      await expect(list).toBeVisible();
    });

    test('renders as ol element', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const list = component.locator('ol[data-slot="breadcrumb-list"]');
      await expect(list).toBeVisible();
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList className="custom-list">
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const list = component.locator('[data-slot="breadcrumb-list"]');
      await expect(list).toHaveClass(/custom-list/);
    });

    test('has flex layout styling', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const list = component.locator('[data-slot="breadcrumb-list"]');
      await expect(list).toHaveClass(/flex/);
      await expect(list).toHaveClass(/flex-wrap/);
      await expect(list).toHaveClass(/items-center/);
    });
  });

  test.describe('BreadcrumbItem', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const item = component.locator('[data-slot="breadcrumb-item"]');
      await expect(item).toBeVisible();
    });

    test('renders as li element', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const item = component.locator('li[data-slot="breadcrumb-item"]');
      await expect(item).toBeVisible();
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="custom-item">
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const item = component.locator('[data-slot="breadcrumb-item"]');
      await expect(item).toHaveClass(/custom-item/);
    });
  });

  test.describe('BreadcrumbLink', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const link = component.locator('[data-slot="breadcrumb-link"]');
      await expect(link).toBeVisible();
      await expect(link).toHaveText('Home');
    });

    test('renders as anchor element', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/test">Test</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const link = component.locator('a[data-slot="breadcrumb-link"]');
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', '/test');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/" className="custom-link">
                Home
              </BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const link = component.locator('[data-slot="breadcrumb-link"]');
      await expect(link).toHaveClass(/custom-link/);
    });

    test('has hover transition styling', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const link = component.locator('[data-slot="breadcrumb-link"]');
      await expect(link).toHaveClass(/transition-colors/);
    });
  });

  test.describe('BreadcrumbPage', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toBeVisible();
      await expect(page_).toHaveText('Current');
    });

    test('has role="link"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toHaveAttribute('role', 'link');
    });

    test('has aria-disabled="true"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toHaveAttribute('aria-disabled', 'true');
    });

    test('has aria-current="page"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toHaveAttribute('aria-current', 'page');
    });

    test('has foreground text styling', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toHaveClass(/text-foreground/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage className="custom-page">Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toHaveClass(/custom-page/);
    });
  });

  test.describe('BreadcrumbSeparator', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const separator = component.locator('[data-slot="breadcrumb-separator"]');
      await expect(separator).toBeVisible();
    });

    test('has role="presentation"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbSeparator />
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const separator = component.locator('[data-slot="breadcrumb-separator"]');
      await expect(separator).toHaveAttribute('role', 'presentation');
    });

    test('has aria-hidden="true"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbSeparator />
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const separator = component.locator('[data-slot="breadcrumb-separator"]');
      await expect(separator).toHaveAttribute('aria-hidden', 'true');
    });

    test('renders default chevron icon', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbSeparator />
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const svg = component.locator('[data-slot="breadcrumb-separator"] svg');
      await expect(svg).toBeVisible();
    });

    test('renders custom separator content', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbSeparator>/</BreadcrumbSeparator>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const separator = component.locator('[data-slot="breadcrumb-separator"]');
      await expect(separator).toHaveText('/');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbSeparator className="custom-sep" />
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const separator = component.locator('[data-slot="breadcrumb-separator"]');
      await expect(separator).toHaveClass(/custom-sep/);
    });
  });

  test.describe('BreadcrumbEllipsis', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const ellipsis = component.locator('[data-slot="breadcrumb-ellipsis"]');
      await expect(ellipsis).toBeVisible();
    });

    test('has role="presentation"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const ellipsis = component.locator('[data-slot="breadcrumb-ellipsis"]');
      await expect(ellipsis).toHaveAttribute('role', 'presentation');
    });

    test('has aria-hidden="true"', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const ellipsis = component.locator('[data-slot="breadcrumb-ellipsis"]');
      await expect(ellipsis).toHaveAttribute('aria-hidden', 'true');
    });

    test('contains dots icon', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const svg = component.locator('[data-slot="breadcrumb-ellipsis"] svg');
      await expect(svg).toBeVisible();
    });

    test('contains sr-only "More" text', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const srOnly = component.locator('[data-slot="breadcrumb-ellipsis"] .sr-only');
      await expect(srOnly).toHaveText('More');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbEllipsis className="custom-ellipsis" />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const ellipsis = component.locator('[data-slot="breadcrumb-ellipsis"]');
      await expect(ellipsis).toHaveClass(/custom-ellipsis/);
    });
  });

  test.describe('composition', () => {
    test('renders breadcrumb with ellipsis for truncation', async ({ mount, page }) => {
      await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="/category">Category</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Current Item</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );

      await expect(page.locator('[data-slot="breadcrumb-link"]')).toHaveCount(2);
      await expect(page.locator('[data-slot="breadcrumb-ellipsis"]')).toBeVisible();
      await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText('Current Item');
    });

    test('maintains proper nesting structure', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Page</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );

      const nav = component;
      const list = nav.locator('[data-slot="breadcrumb-list"]');
      const items = list.locator('[data-slot="breadcrumb-item"]');

      await expect(nav).toBeVisible();
      await expect(list).toBeVisible();
      await expect(items).toHaveCount(2);
    });
  });

  test.describe('accessibility', () => {
    test('navigation landmark is present', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      await expect(component).toHaveRole('navigation');
      await expect(component).toHaveAccessibleName('breadcrumb');
    });

    test('separators are hidden from assistive technologies', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Current</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const separator = component.locator('[data-slot="breadcrumb-separator"]');
      await expect(separator).toHaveAttribute('aria-hidden', 'true');
    });

    test('current page is indicated via aria-current', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Dashboard</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const page_ = component.locator('[data-slot="breadcrumb-page"]');
      await expect(page_).toHaveAttribute('aria-current', 'page');
    });

    test('links are navigable', async ({ mount }) => {
      const component = await mount(
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/home">Home</BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>,
      );
      const link = component.locator('[data-slot="breadcrumb-link"]');
      await expect(link).toHaveAttribute('href', '/home');
    });
  });
});

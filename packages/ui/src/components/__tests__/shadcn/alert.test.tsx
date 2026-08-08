import { test, expect } from '@playwright/experimental-ct-react';
import { Alert, AlertTitle, AlertDescription } from '../../shadcn/alert';
import { runAxe, formatViolations, setTheme } from '../helpers/axe';

test.describe('Alert', () => {
  test.describe('Alert (root)', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Alert>Alert content</Alert>);
      await expect(component).toBeVisible();
      await expect(component).toHaveText('Alert content');
      await expect(component).toHaveAttribute('data-slot', 'alert');
    });

    test('has alert role', async ({ mount }) => {
      const component = await mount(<Alert>Alert</Alert>);
      await expect(component).toHaveRole('alert');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Alert className="custom-alert">Alert</Alert>);
      await expect(component).toHaveClass(/custom-alert/);
    });

    test('has correct default styling', async ({ mount }) => {
      const component = await mount(<Alert>Alert</Alert>);
      await expect(component).toHaveClass(/rounded-lg/);
      await expect(component).toHaveClass(/border/);
      await expect(component).toHaveClass(/w-full/);
    });
  });

  test.describe('variants', () => {
    test('renders default variant', async ({ mount }) => {
      const component = await mount(<Alert variant="default">Default</Alert>);
      await expect(component).toHaveClass(/bg-card/);
      await expect(component).toHaveClass(/text-card-foreground/);
    });

    test('renders destructive variant', async ({ mount }) => {
      const component = await mount(<Alert variant="destructive">Destructive</Alert>);
      await expect(component).toHaveClass(/text-destructive/);
    });
  });

  test.describe('AlertTitle', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<AlertTitle>Title</AlertTitle>);
      await expect(component).toHaveAttribute('data-slot', 'alert-title');
    });

    test('applies font styling', async ({ mount }) => {
      const component = await mount(<AlertTitle>Title</AlertTitle>);
      await expect(component).toHaveClass(/font-medium/);
      await expect(component).toHaveClass(/tracking-tight/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<AlertTitle className="text-lg">Large Title</AlertTitle>);
      await expect(component).toHaveClass(/text-lg/);
    });

    test('renders within Alert', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <AlertTitle>Alert Title</AlertTitle>
        </Alert>,
      );
      const title = component.locator('[data-slot="alert-title"]');
      await expect(title).toBeVisible();
      await expect(title).toHaveText('Alert Title');
    });
  });

  test.describe('AlertDescription', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<AlertDescription>Description</AlertDescription>);
      await expect(component).toHaveAttribute('data-slot', 'alert-description');
    });

    test('applies muted text styling', async ({ mount }) => {
      const component = await mount(<AlertDescription>Description</AlertDescription>);
      await expect(component).toHaveClass(/text-muted-foreground/);
      await expect(component).toHaveClass(/text-sm/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<AlertDescription className="text-base">Description</AlertDescription>);
      await expect(component).toHaveClass(/text-base/);
    });

    test('renders within Alert', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <AlertDescription>Alert description text</AlertDescription>
        </Alert>,
      );
      const description = component.locator('[data-slot="alert-description"]');
      await expect(description).toBeVisible();
      await expect(description).toHaveText('Alert description text');
    });
  });

  test.describe('Full Alert composition', () => {
    test('renders complete alert structure', async ({ mount, page }) => {
      const component = await mount(
        <Alert>
          <AlertTitle>Alert Title</AlertTitle>
          <AlertDescription>This is the alert description.</AlertDescription>
        </Alert>,
      );

      await expect(page.locator('[data-slot="alert"]')).toBeVisible();
      await expect(component.locator('[data-slot="alert-title"]')).toHaveText('Alert Title');
      await expect(component.locator('[data-slot="alert-description"]')).toHaveText('This is the alert description.');
    });

    test('renders with icon', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <svg data-testid="alert-icon" width="16" height="16" />
          <AlertTitle>With Icon</AlertTitle>
          <AlertDescription>Description</AlertDescription>
        </Alert>,
      );

      const icon = component.locator('[data-testid="alert-icon"]');
      await expect(icon).toBeVisible();
    });

    test('destructive alert with full content', async ({ mount }) => {
      const component = await mount(
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Something went wrong.</AlertDescription>
        </Alert>,
      );

      await expect(component).toHaveClass(/text-destructive/);
      await expect(component.locator('[data-slot="alert-title"]')).toHaveText('Error');
    });
  });

  test.describe('accessibility', () => {
    test('alert has role="alert"', async ({ mount }) => {
      const component = await mount(<Alert>Important message</Alert>);
      await expect(component).toHaveRole('alert');
    });

    test('alert content is accessible', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <AlertTitle>Attention</AlertTitle>
          <AlertDescription>Please review this message.</AlertDescription>
        </Alert>,
      );

      await expect(component).toContainText('Attention');
      await expect(component).toContainText('Please review this message.');
    });

    test('supports aria-labelledby', async ({ mount }) => {
      const component = await mount(
        <Alert aria-labelledby="alert-heading">
          <AlertTitle id="alert-heading">Warning</AlertTitle>
          <AlertDescription>Be careful!</AlertDescription>
        </Alert>,
      );

      await expect(component).toHaveAttribute('aria-labelledby', 'alert-heading');
    });

    /**
     * Contrast gate for the destructive variant.
     *
     * The description tint is applied by the PARENT via a `*:` variant
     * (`:is(.alert > *)`, specificity 0-2-0), so it cannot be overridden from
     * `AlertDescription` — a regression has to be caught on the primitive
     * itself. `text-destructive/90` previously computed to 4.08:1 on the card
     * surface and failed WCAG 1.4.3 for every destructive alert in the console
     * (notably `OccConflictAlert`, the 412/428 banner).
     *
     * Screen-level axe suites do not cover this: they scan a default state
     * where no destructive alert happens to be rendered.
     */
    for (const theme of ['light', 'dark'] as const) {
      test(`destructive variant meets WCAG 1.4.3 contrast (${theme})`, async ({ mount, page }) => {
        await mount(
          <Alert variant="destructive">
            <svg width="16" height="16" aria-hidden="true" />
            <AlertTitle>Update conflict</AlertTitle>
            <AlertDescription>
              <p>This record changed since you opened it. Reload to see the current values, then reapply your edit.</p>
            </AlertDescription>
          </Alert>,
        );
        await setTheme(page, theme);

        const violations = await runAxe(page, { runOnly: ['color-contrast'] });
        expect(violations, formatViolations(violations)).toEqual([]);
      });

      test(`destructive variant has no WCAG 2.2 AA violations (${theme})`, async ({ mount, page }) => {
        await mount(
          <Alert variant="destructive">
            <AlertTitle>Save failed</AlertTitle>
            <AlertDescription>
              <p>The server rejected the change.</p>
            </AlertDescription>
          </Alert>,
        );
        await setTheme(page, theme);

        const violations = await runAxe(page);
        expect(violations, formatViolations(violations)).toEqual([]);
      });
    }

    test('supports aria-describedby', async ({ mount }) => {
      const component = await mount(
        <Alert aria-describedby="alert-desc">
          <AlertTitle>Notice</AlertTitle>
          <AlertDescription id="alert-desc">This is important information.</AlertDescription>
        </Alert>,
      );

      await expect(component).toHaveAttribute('aria-describedby', 'alert-desc');
    });
  });

  test.describe('styling', () => {
    test('has grid layout', async ({ mount }) => {
      const component = await mount(<Alert>Alert</Alert>);
      await expect(component).toHaveClass(/grid/);
    });

    test('has padding', async ({ mount }) => {
      const component = await mount(<Alert>Alert</Alert>);
      await expect(component).toHaveClass(/px-4/);
      await expect(component).toHaveClass(/py-3/);
    });

    test('has small text', async ({ mount }) => {
      const component = await mount(<Alert>Alert</Alert>);
      await expect(component).toHaveClass(/text-sm/);
    });
  });

  test.describe('custom attributes', () => {
    test('passes through data attributes', async ({ mount }) => {
      const component = await mount(
        <Alert data-testid="test-alert" data-type="info">
          Alert
        </Alert>,
      );
      await expect(component).toHaveAttribute('data-testid', 'test-alert');
      await expect(component).toHaveAttribute('data-type', 'info');
    });

    test('passes through id attribute', async ({ mount }) => {
      const component = await mount(<Alert id="my-alert">Alert</Alert>);
      await expect(component).toHaveAttribute('id', 'my-alert');
    });
  });

  test.describe('use cases', () => {
    test('success alert', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <AlertTitle>Success!</AlertTitle>
          <AlertDescription>Your changes have been saved successfully.</AlertDescription>
        </Alert>,
      );

      await expect(component).toContainText('Success!');
      await expect(component).toContainText('saved successfully');
    });

    test('warning alert', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <AlertTitle>Warning</AlertTitle>
          <AlertDescription>Your session will expire in 5 minutes.</AlertDescription>
        </Alert>,
      );

      await expect(component).toContainText('Warning');
      await expect(component).toContainText('session will expire');
    });

    test('error alert', async ({ mount }) => {
      const component = await mount(
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to save changes. Please try again.</AlertDescription>
        </Alert>,
      );

      await expect(component).toHaveClass(/text-destructive/);
      await expect(component).toContainText('Failed to save');
    });

    test('info alert with link', async ({ mount }) => {
      const component = await mount(
        <Alert>
          <AlertTitle>New Update Available</AlertTitle>
          <AlertDescription>
            <p>A new version is available.</p>
            <a href="#" className="underline">
              Learn more
            </a>
          </AlertDescription>
        </Alert>,
      );

      const link = component.getByRole('link', { name: 'Learn more' });
      await expect(link).toBeVisible();
    });
  });
});

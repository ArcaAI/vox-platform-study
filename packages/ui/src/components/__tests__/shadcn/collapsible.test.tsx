import { test, expect } from '@playwright/experimental-ct-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../../shadcn/collapsible';

test.describe('Collapsible', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attributes', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      await expect(page.locator('[data-slot="collapsible"]')).toBeVisible();
      await expect(page.locator('[data-slot="collapsible-trigger"]')).toBeVisible();
    });

    test('renders trigger text', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle Section</CollapsibleTrigger>
          <CollapsibleContent>Hidden content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await expect(trigger).toHaveText('Toggle Section');
    });

    test('applies custom className to collapsible', async ({ mount, page }) => {
      await mount(
        <Collapsible className="custom-collapsible">
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const collapsible = page.locator('[data-slot="collapsible"]');
      await expect(collapsible).toHaveClass(/custom-collapsible/);
    });

    test('applies custom className to trigger', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger className="custom-trigger">Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await expect(trigger).toHaveClass(/custom-trigger/);
    });

    test('applies custom className to content', async ({ mount, page }) => {
      await mount(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent className="custom-content">Content</CollapsibleContent>
        </Collapsible>,
      );

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toHaveClass(/custom-content/);
    });
  });

  test.describe('default state', () => {
    test('content is hidden by default', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Hidden content</CollapsibleContent>
        </Collapsible>,
      );

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).not.toBeVisible();
    });

    test('content is visible when defaultOpen is true', async ({ mount, page }) => {
      await mount(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Visible content</CollapsibleContent>
        </Collapsible>,
      );

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toBeVisible();
      await expect(content).toHaveText('Visible content');
    });

    test('has closed data-state by default', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const collapsible = page.locator('[data-slot="collapsible"]');
      await expect(collapsible).toHaveAttribute('data-state', 'closed');
    });

    test('has open data-state when defaultOpen', async ({ mount, page }) => {
      await mount(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const collapsible = page.locator('[data-slot="collapsible"]');
      await expect(collapsible).toHaveAttribute('data-state', 'open');
    });
  });

  test.describe('interactions', () => {
    test('opens content when trigger is clicked', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Revealed content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.click();

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toBeVisible();
      await expect(content).toHaveText('Revealed content');
    });

    test('closes content when trigger is clicked again', async ({ mount, page }) => {
      await mount(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.click();

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).not.toBeVisible();
    });

    test('toggles data-state on click', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const collapsible = page.locator('[data-slot="collapsible"]');
      await expect(collapsible).toHaveAttribute('data-state', 'closed');

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.click();
      await expect(collapsible).toHaveAttribute('data-state', 'open');

      await trigger.click();
      await expect(collapsible).toHaveAttribute('data-state', 'closed');
    });

    test('opens with Enter key', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.focus();
      await trigger.press('Enter');

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toBeVisible();
    });

    test('opens with Space key', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.focus();
      await trigger.press(' ');

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toBeVisible();
    });
  });

  test.describe('controlled state', () => {
    test('respects open prop', async ({ mount, page }) => {
      await mount(
        <Collapsible open={true}>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Controlled content</CollapsibleContent>
        </Collapsible>,
      );

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toBeVisible();
    });

    test('disabled collapsible does not toggle', async ({ mount, page }) => {
      await mount(
        <Collapsible disabled>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.click({ force: true });

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('trigger has button role', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await expect(trigger).toHaveRole('button');
    });

    test('trigger has aria-expanded false when closed', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    test('trigger has aria-expanded true when open', async ({ mount, page }) => {
      await mount(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    test('trigger aria-expanded updates on toggle', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');

      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    test('trigger controls content via aria-controls', async ({ mount, page }) => {
      await mount(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      const controlsId = await trigger.getAttribute('aria-controls');
      expect(controlsId).toBeTruthy();

      const content = page.locator('[data-slot="collapsible-content"]');
      await expect(content).toHaveAttribute('id', controlsId!);
    });

    test('trigger is focusable', async ({ mount, page }) => {
      await mount(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>Content</CollapsibleContent>
        </Collapsible>,
      );

      const trigger = page.locator('[data-slot="collapsible-trigger"]');
      await trigger.focus();
      await expect(trigger).toBeFocused();
    });
  });
});

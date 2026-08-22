import { test, expect } from '@playwright/experimental-ct-react';
import { BasicHoverCard, DefaultOpenHoverCard, HoverCardWithCustomClass, HoverCardWithAlign } from '../fixtures/shadcn/hover-card-fixtures';

test.describe('HoverCard', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const trigger = page.getByRole('button', { name: 'Hover me' });
      await expect(trigger).toBeVisible();
    });

    test('trigger has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const trigger = page.locator('[data-slot="hover-card-trigger"]');
      await expect(trigger).toBeVisible();
    });

    test('content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).not.toBeVisible();
    });

    test('content is visible when defaultOpen is true', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();
    });

    test('renders content text when open', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toContainText('Visible content');
    });
  });

  test.describe('hover interaction', () => {
    test('content appears on hover', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const trigger = page.getByRole('button', { name: 'Hover me' });
      await trigger.hover();

      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();
    });

    test('content shows all children on hover', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const trigger = page.getByRole('button', { name: 'Hover me' });
      await trigger.hover();

      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toContainText('Hover card content');
      await expect(content).toContainText('Additional details here');
    });

    test('content hides when hover leaves', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const trigger = page.getByRole('button', { name: 'Hover me' });
      await trigger.hover();

      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();

      await page.mouse.move(1200, 700);
      await page.waitForTimeout(500);
      await expect(content).not.toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('content structure', () => {
    test('content has data-slot attribute', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveAttribute('data-slot', 'hover-card-content');
    });

    test('content has popover background class', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveClass(/bg-popover/);
    });

    test('content has border and shadow styling', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveClass(/border/);
      await expect(content).toHaveClass(/shadow-overlay/);
    });

    test('content has animation classes', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:animate-in/);
    });
  });

  test.describe('custom className', () => {
    test('applies custom className to content', async ({ mount, page }) => {
      await mount(<HoverCardWithCustomClass />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveClass(/custom-hover-class/);
    });

    test('preserves default classes with custom className', async ({ mount, page }) => {
      await mount(<HoverCardWithCustomClass />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveClass(/bg-popover/);
      await expect(content).toHaveClass(/custom-hover-class/);
    });
  });

  test.describe('alignment', () => {
    test('renders with default center alignment', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();
    });

    test('renders with start alignment', async ({ mount, page }) => {
      await mount(<HoverCardWithAlign align="start" />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();
    });

    test('renders with end alignment', async ({ mount, page }) => {
      await mount(<HoverCardWithAlign align="end" />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('trigger is keyboard focusable', async ({ mount, page }) => {
      await mount(<BasicHoverCard />);
      const trigger = page.getByRole('button', { name: 'Hover me' });
      await trigger.focus();
      await expect(trigger).toBeFocused();
    });

    test('content renders in a portal', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toBeVisible();
      const parent = content.locator('..');
      const parentTag = await parent.evaluate((el) => el.tagName.toLowerCase());
      expect(parentTag).toBe('div');
    });

    test('content has correct z-index class', async ({ mount, page }) => {
      await mount(<DefaultOpenHoverCard />);
      const content = page.locator('[data-slot="hover-card-content"]');
      await expect(content).toHaveClass(/z-overlay/);
    });
  });
});

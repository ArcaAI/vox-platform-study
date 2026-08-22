import { test, expect } from '@playwright/experimental-ct-react';
import { BasicNavigationMenu, NavigationMenuNoViewport, NavigationMenuWithCustomClass } from '../fixtures/shadcn/navigation-menu-fixtures';

test.describe('NavigationMenu', () => {
  test.describe('rendering', () => {
    test('renders navigation menu', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toBeVisible();
    });

    test('renders navigation menu list', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const list = page.locator('[data-slot="navigation-menu-list"]');
      await expect(list).toBeVisible();
    });

    test('renders trigger buttons', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const gettingStarted = page.locator('[data-slot="navigation-menu-trigger"]').filter({ hasText: 'Getting Started' });
      const components = page.locator('[data-slot="navigation-menu-trigger"]').filter({ hasText: 'Components' });
      await expect(gettingStarted).toBeVisible();
      await expect(components).toBeVisible();
    });

    test('renders standalone link', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const docLink = page.locator('[data-slot="navigation-menu-link"]').filter({ hasText: 'Documentation' });
      await expect(docLink).toBeVisible();
    });

    test('content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const content = page.locator('[data-slot="navigation-menu-content"]');
      await expect(content.first()).not.toBeVisible();
    });
  });

  test.describe('opening', () => {
    test('shows content when trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').filter({ hasText: 'Getting Started' });
      await trigger.click();

      const content = page.locator('[data-slot="navigation-menu-content"]').first();
      await expect(content).toBeVisible();
    });

    test('shows content when trigger is hovered', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').filter({ hasText: 'Getting Started' });
      await trigger.hover();

      const content = page.locator('[data-slot="navigation-menu-content"]').first();
      await expect(content).toBeVisible();
    });
  });

  test.describe('content', () => {
    test('renders links when content is open', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').filter({ hasText: 'Getting Started' });
      await trigger.click();

      const introLink = page.locator('[data-slot="navigation-menu-link"]').filter({ hasText: 'Introduction' });
      const installLink = page.locator('[data-slot="navigation-menu-link"]').filter({ hasText: 'Installation' });
      await expect(introLink).toBeVisible();
      await expect(installLink).toBeVisible();
    });

    test('shows different content for different triggers', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const componentsTrigger = page.locator('[data-slot="navigation-menu-trigger"]').filter({ hasText: 'Components' });
      await componentsTrigger.click();

      const buttonLink = page.locator('[data-slot="navigation-menu-link"]').filter({ hasText: 'Button' });
      const cardLink = page.locator('[data-slot="navigation-menu-link"]').filter({ hasText: 'Card' });
      await expect(buttonLink).toBeVisible();
      await expect(cardLink).toBeVisible();
    });
  });

  test.describe('viewport', () => {
    test('does not render viewport when viewport=false', async ({ mount, page }) => {
      await mount(<NavigationMenuNoViewport />);
      const viewport = page.locator('[data-slot="navigation-menu-viewport"]');
      await expect(viewport).not.toBeAttached();
    });

    test('menu has data-viewport attribute set to true by default', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toHaveAttribute('data-viewport', 'true');
    });

    test('menu has data-viewport attribute set to false', async ({ mount, page }) => {
      await mount(<NavigationMenuNoViewport />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toHaveAttribute('data-viewport', 'false');
    });
  });

  test.describe('styling', () => {
    test('navigation menu has flex class', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toHaveClass(/flex/);
    });

    test('trigger has h-9 class', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').first();
      await expect(trigger).toHaveClass(/h-9/);
    });

    test('trigger has rounded-control class', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').first();
      await expect(trigger).toHaveClass(/rounded-control/);
    });

    test('trigger includes chevron icon', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').first();
      const chevron = trigger.locator('svg');
      await expect(chevron).toBeVisible();
    });

    test('list has flex class', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const list = page.locator('[data-slot="navigation-menu-list"]');
      await expect(list).toHaveClass(/flex/);
    });
  });

  test.describe('accessibility', () => {
    test('navigation menu has navigation role', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const nav = page.getByRole('navigation');
      await expect(nav).toBeVisible();
    });

    test('menu list has list role', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const list = page.getByRole('list');
      await expect(list.first()).toBeVisible();
    });

    test('menu has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toHaveAttribute('data-slot', 'navigation-menu');
    });

    test('links have proper href', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const docLink = page.locator('[data-slot="navigation-menu-link"]').filter({ hasText: 'Documentation' });
      await expect(docLink).toHaveAttribute('href', '#');
    });

    test('chevron icon is hidden from assistive technology', async ({ mount, page }) => {
      await mount(<BasicNavigationMenu />);
      const trigger = page.locator('[data-slot="navigation-menu-trigger"]').first();
      const chevron = trigger.locator('svg');
      await expect(chevron).toHaveAttribute('aria-hidden', 'true');
    });
  });

  test.describe('custom className', () => {
    test('supports custom className on NavigationMenu', async ({ mount, page }) => {
      await mount(<NavigationMenuWithCustomClass />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toHaveClass(/custom-nav-class/);
    });

    test('preserves default classes with custom className', async ({ mount, page }) => {
      await mount(<NavigationMenuWithCustomClass />);
      const menu = page.locator('[data-slot="navigation-menu"]');
      await expect(menu).toHaveClass(/flex/);
      await expect(menu).toHaveClass(/custom-nav-class/);
    });
  });
});

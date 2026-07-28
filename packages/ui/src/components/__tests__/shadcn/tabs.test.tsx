import { test, expect } from '@playwright/experimental-ct-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../shadcn/tabs';
import { BasicTabs, LineTabs, TabsWithDisabled } from '../fixtures/shadcn/tabs-fixtures';

test.describe('Tabs', () => {
  test.describe('rendering', () => {
    test('renders tabs with default value selected', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await expect(tab1).toHaveAttribute('data-state', 'active');
    });

    test('renders all tab triggers', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      await expect(page.getByRole('tab', { name: 'Tab 1' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Tab 2' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Tab 3' })).toBeVisible();
    });

    test('renders content for active tab', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const content1 = page.locator('[data-slot="tabs-content"]').first();
      await expect(content1).toContainText('Content 1');
    });

    test('has correct data-slot attributes', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      await expect(page.locator('[data-slot="tabs"]')).toBeVisible();
      await expect(page.locator('[data-slot="tabs-list"]')).toBeVisible();
      await expect(page.locator('[data-slot="tabs-trigger"]').first()).toBeVisible();
      await expect(page.locator('[data-slot="tabs-content"]').first()).toBeVisible();
    });
  });

  test.describe('orientation', () => {
    test('renders horizontal tabs by default', async ({ mount, page }) => {
      await mount(<BasicTabs />);
      const tabs = page.locator('[data-slot="tabs"]');
      await expect(tabs).toHaveAttribute('data-orientation', 'horizontal');
    });

    test('renders vertical tabs when specified', async ({ mount, page }) => {
      await mount(<BasicTabs orientation="vertical" />);
      const tabs = page.locator('[data-slot="tabs"]');
      await expect(tabs).toHaveAttribute('data-orientation', 'vertical');
    });
  });

  test.describe('variants', () => {
    test('renders default variant', async ({ mount, page }) => {
      await mount(<BasicTabs />);
      const tabsList = page.locator('[data-slot="tabs-list"]');
      await expect(tabsList).toHaveAttribute('data-variant', 'default');
      await expect(tabsList).toHaveClass(/bg-muted/);
    });

    test('renders line variant', async ({ mount, page }) => {
      await mount(<LineTabs />);
      const tabsList = page.locator('[data-slot="tabs-list"]');
      await expect(tabsList).toHaveAttribute('data-variant', 'line');
    });
  });

  test.describe('tab switching', () => {
    test('switches content when tab is clicked', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      await page.getByRole('tab', { name: 'Tab 2' }).click();

      await expect(page.getByRole('tab', { name: 'Tab 2' })).toHaveAttribute('data-state', 'active');

      const content2 = page.locator('[data-slot="tabs-content"]').nth(1);
      await expect(content2).toContainText('Content 2');
    });

    test('previous tab becomes inactive', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      await expect(page.getByRole('tab', { name: 'Tab 1' })).toHaveAttribute('data-state', 'active');

      await page.getByRole('tab', { name: 'Tab 2' }).click();

      await expect(page.getByRole('tab', { name: 'Tab 1' })).toHaveAttribute('data-state', 'inactive');
    });
  });

  test.describe('keyboard navigation', () => {
    test('navigates with arrow keys (horizontal)', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await tab1.focus();

      await tab1.press('ArrowRight');

      const tab2 = page.getByRole('tab', { name: 'Tab 2' });
      await expect(tab2).toBeFocused();
    });

    test('navigates with arrow keys (vertical)', async ({ mount, page }) => {
      await mount(<BasicTabs orientation="vertical" />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await tab1.focus();

      await tab1.press('ArrowDown');

      const tab2 = page.getByRole('tab', { name: 'Tab 2' });
      await expect(tab2).toBeFocused();
    });

    test('wraps around at the end', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab3 = page.getByRole('tab', { name: 'Tab 3' });
      await tab3.focus();

      await tab3.press('ArrowRight');

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await expect(tab1).toBeFocused();
    });

    test('wraps around at the beginning', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await tab1.focus();

      await tab1.press('ArrowLeft');

      const tab3 = page.getByRole('tab', { name: 'Tab 3' });
      await expect(tab3).toBeFocused();
    });

    test('Home key moves to first tab', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab3 = page.getByRole('tab', { name: 'Tab 3' });
      await tab3.focus();
      await tab3.press('Home');

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await expect(tab1).toBeFocused();
    });

    test('End key moves to last tab', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await tab1.focus();
      await tab1.press('End');

      const tab3 = page.getByRole('tab', { name: 'Tab 3' });
      await expect(tab3).toBeFocused();
    });
  });

  test.describe('disabled tabs', () => {
    test('disabled tab has disabled attribute', async ({ mount, page }) => {
      await mount(<TabsWithDisabled />);

      const disabledTab = page.getByRole('tab', {
        name: 'Tab 2 (Disabled)',
      });
      await expect(disabledTab).toBeDisabled();
    });

    test('disabled tab cannot be activated by click', async ({ mount, page }) => {
      await mount(<TabsWithDisabled />);

      const disabledTab = page.getByRole('tab', {
        name: 'Tab 2 (Disabled)',
      });
      await disabledTab.click({ force: true });

      await expect(page.getByRole('tab', { name: 'Tab 1' })).toHaveAttribute('data-state', 'active');
    });

    test('keyboard navigation skips disabled tabs', async ({ mount, page }) => {
      await mount(<TabsWithDisabled />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await tab1.focus();
      await tab1.press('ArrowRight');

      const tab3 = page.getByRole('tab', { name: 'Tab 3' });
      await expect(tab3).toBeFocused();
    });
  });

  test.describe('focus', () => {
    test('tab trigger is focusable', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await tab1.focus();
      await expect(tab1).toBeFocused();
    });

    test('shows focus ring on tab', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const trigger = page.locator('[data-slot="tabs-trigger"]').first();
      await expect(trigger).toHaveClass(/focus-visible:ring/);
    });
  });

  test.describe('accessibility', () => {
    test('tablist has tablist role', async ({ mount, page }) => {
      await mount(<BasicTabs />);
      await expect(page.getByRole('tablist')).toBeVisible();
    });

    test('triggers have tab role', async ({ mount, page }) => {
      await mount(<BasicTabs />);
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(3);
    });

    test('content has tabpanel role', async ({ mount, page }) => {
      await mount(<BasicTabs />);
      await expect(page.getByRole('tabpanel')).toBeVisible();
    });

    test('active tab has aria-selected true', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      await expect(tab1).toHaveAttribute('aria-selected', 'true');
    });

    test('inactive tabs have aria-selected false', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab2 = page.getByRole('tab', { name: 'Tab 2' });
      await expect(tab2).toHaveAttribute('aria-selected', 'false');
    });

    test('tab controls its panel', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      const controlsId = await tab1.getAttribute('aria-controls');
      expect(controlsId).toBeTruthy();

      const panel = page.getByRole('tabpanel');
      await expect(panel).toHaveAttribute('id', controlsId!);
    });

    test('tabpanel is labelled by its tab', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tab1 = page.getByRole('tab', { name: 'Tab 1' });
      const tabId = await tab1.getAttribute('id');
      expect(tabId).toBeTruthy();

      const panel = page.getByRole('tabpanel');
      await expect(panel).toHaveAttribute('aria-labelledby', tabId!);
    });
  });

  test.describe('styling', () => {
    test('active tab has active styles', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const activeTab = page.getByRole('tab', { name: 'Tab 1' });
      await expect(activeTab).toHaveClass(/data-\[state=active\]:bg-background/);
    });

    test('tabs list has correct styling', async ({ mount, page }) => {
      await mount(<BasicTabs />);

      const tabsList = page.locator('[data-slot="tabs-list"]');
      await expect(tabsList).toHaveClass(/rounded-lg/);
      await expect(tabsList).toHaveClass(/inline-flex/);
    });
  });

  test.describe('custom className', () => {
    test('Tabs accepts custom className', async ({ mount, page }) => {
      await mount(
        <Tabs defaultValue="tab1" className="custom-tabs">
          <TabsList>
            <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          </TabsList>
          <TabsContent value="tab1">Content</TabsContent>
        </Tabs>,
      );

      const tabs = page.locator('[data-slot="tabs"]');
      await expect(tabs).toHaveClass(/custom-tabs/);
    });

    test('TabsList accepts custom className', async ({ mount, page }) => {
      await mount(
        <Tabs defaultValue="tab1">
          <TabsList className="custom-tabs-list">
            <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          </TabsList>
          <TabsContent value="tab1">Content</TabsContent>
        </Tabs>,
      );

      const tabsList = page.locator('[data-slot="tabs-list"]');
      await expect(tabsList).toHaveClass(/custom-tabs-list/);
    });

    test('TabsTrigger accepts custom className', async ({ mount, page }) => {
      await mount(
        <Tabs defaultValue="tab1">
          <TabsList>
            <TabsTrigger value="tab1" className="custom-trigger">
              Tab 1
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tab1">Content</TabsContent>
        </Tabs>,
      );

      const trigger = page.locator('[data-slot="tabs-trigger"]');
      await expect(trigger).toHaveClass(/custom-trigger/);
    });

    test('TabsContent accepts custom className', async ({ mount, page }) => {
      await mount(
        <Tabs defaultValue="tab1">
          <TabsList>
            <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          </TabsList>
          <TabsContent value="tab1" className="custom-content">
            Content
          </TabsContent>
        </Tabs>,
      );

      const content = page.locator('[data-slot="tabs-content"]');
      await expect(content).toHaveClass(/custom-content/);
    });
  });
});

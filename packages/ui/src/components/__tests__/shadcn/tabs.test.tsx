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

  test.describe('contrast', () => {
    // Measures the RENDERED colour, not the class string: composites the trigger's
    // own alpha over the first opaque ancestor background, then applies the WCAG
    // relative-luminance formula. An opacity modifier such as `text-foreground/60`
    // (4.50:1 light) fails here even though a class assertion would still pass.
    const inactiveTriggerContrast = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      // Strict on purpose: the sRGB luminance formula below is only valid for rgb()/rgba().
      // A Tailwind opacity modifier resolves to oklab(... / a), whose channels would parse
      // as plausible-looking numbers and yield a silently wrong ratio.
      const channels = (value: string) => {
        if (!/^rgba?\(/.test(value)) {
          throw new Error(`unsupported computed colour "${value}" — expected rgb()/rgba(); an opacity modifier resolves to oklab()`);
        }
        return (value.match(/[\d.]+/g) ?? []).map(Number);
      };

      const fg = channels(getComputedStyle(el).color);
      let opaque: number[] | null = null;
      for (let node: Element | null = el; node; node = node.parentElement) {
        const candidate = channels(getComputedStyle(node).backgroundColor);
        if (candidate.length >= 3 && (candidate[3] ?? 1) > 0) {
          opaque = candidate;
          break;
        }
      }
      if (!opaque) throw new Error('no opaque background found in the ancestor chain');
      const bg = opaque;

      const alpha = fg[3] ?? 1;
      const composited = [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]);
      const toLinear = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const luminance = (rgb: number[]) => 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
      const [hi, lo] = [luminance(composited), luminance(bg)].sort((a, b) => b - a);
      return { ratio: (hi + 0.05) / (lo + 0.05), color: getComputedStyle(el).color, alpha };
    };

    const INACTIVE = '[data-slot="tabs-trigger"][data-state="inactive"]';

    for (const theme of ['light', 'dark'] as const) {
      for (const variant of ['default', 'line'] as const) {
        // WCAG 2.2 AA 1.4.3 — 4.5:1 for normal-weight text at this size (14px).
        test(`inactive ${variant} trigger meets 4.5:1 in the ${theme} theme`, async ({ mount, page }) => {
          // Theme is set BEFORE mount deliberately. Adding `.dark` to an already-painted
          // tree updates --muted-foreground but leaves the resolved `color` stale, which
          // would make this assert the light value while claiming to test dark.
          if (theme === 'dark') {
            await page.evaluate(() => document.documentElement.classList.add('dark'));
          }
          await mount(variant === 'line' ? <LineTabs /> : <BasicTabs />);

          const { ratio, color, alpha } = await page.evaluate(inactiveTriggerContrast, INACTIVE);

          // The colour must be a solid token, not `text-foreground/<n>`. An opacity
          // modifier lands within rounding distance of the floor (the original defect
          // measured 4.49:1 in axe and 4.4996:1 here), so the ratio assert alone is too
          // slack to catch a regression to it. Opacity is the thing to forbid outright.
          expect(alpha, `inactive ${variant} trigger rendered ${color}; expected a solid colour token`).toBe(1);
          expect(ratio, `inactive ${variant} trigger rendered ${color} at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });
});

import { test, expect } from '@playwright/experimental-ct-react';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../../shadcn/accordion';

test.describe('Accordion', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      await expect(component).toHaveAttribute('data-slot', 'accordion');
    });

    test('renders multiple items', async ({ mount, page }) => {
      await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>Section 2</AccordionTrigger>
            <AccordionContent>Content 2</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>Section 3</AccordionTrigger>
            <AccordionContent>Content 3</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const items = page.locator('[data-slot="accordion-item"]');
      await expect(items).toHaveCount(3);
    });

    test('renders AccordionItem with data-slot', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      const item = component.locator('[data-slot="accordion-item"]');
      await expect(item).toBeVisible();
    });

    test('renders AccordionTrigger with data-slot', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveText('Section 1');
    });

    test('renders chevron icon in trigger', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      const svg = component.locator('[data-slot="accordion-trigger"] svg');
      await expect(svg).toBeVisible();
    });

    test('content is hidden by default', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).not.toBeVisible();
    });

    test('applies custom className to AccordionItem', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1" className="custom-item">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      const item = component.locator('[data-slot="accordion-item"]');
      await expect(item).toHaveClass(/custom-item/);
    });

    test('applies custom className to AccordionTrigger', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger className="custom-trigger">Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );
      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveClass(/custom-trigger/);
    });
  });

  test.describe('interactions', () => {
    test('expands content when trigger is clicked', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await trigger.click();

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toBeVisible();
    });

    test('collapses content when trigger is clicked again', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await trigger.click();
      await trigger.click();

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).not.toBeVisible();
    });

    test('expands content with Enter key', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await trigger.focus();
      await trigger.press('Enter');

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toBeVisible();
    });

    test('expands content with Space key', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await trigger.focus();
      await trigger.press(' ');

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toBeVisible();
    });

    test('only one item open at a time with type="single"', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>Section 2</AccordionTrigger>
            <AccordionContent>Content 2</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const triggers = component.locator('[data-slot="accordion-trigger"]');
      const contents = component.locator('[data-slot="accordion-content"]');

      await triggers.nth(0).click();
      await expect(contents.nth(0)).toBeVisible();

      await triggers.nth(1).click();
      await expect(contents.nth(0)).not.toBeVisible();
      await expect(contents.nth(1)).toBeVisible();
    });

    test('multiple items open at a time with type="multiple"', async ({ mount }) => {
      const component = await mount(
        <Accordion type="multiple">
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>Section 2</AccordionTrigger>
            <AccordionContent>Content 2</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const triggers = component.locator('[data-slot="accordion-trigger"]');
      const contents = component.locator('[data-slot="accordion-content"]');

      await triggers.nth(0).click();
      await triggers.nth(1).click();

      await expect(contents.nth(0)).toBeVisible();
      await expect(contents.nth(1)).toBeVisible();
    });

    test('renders with defaultValue expanded', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" defaultValue="item-1" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toBeVisible();
    });
  });

  test.describe('animations', () => {
    test('content has animation classes when open', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" defaultValue="item-1" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:animate-accordion-down/);
    });

    test('content has closed animation class', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" defaultValue="item-1" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toHaveClass(/data-\[state=closed\]:animate-accordion-up/);
    });

    test('trigger has chevron rotation class', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveClass(/\[&\[data-state=open\]>svg\]:rotate-180/);
    });
  });

  test.describe('accessibility', () => {
    test('trigger has button role', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveRole('button');
    });

    test('trigger has aria-expanded false when closed', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    test('trigger has aria-expanded true when open', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" defaultValue="item-1" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    test('trigger controls content via aria-controls', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      // radix-ui collapsible now only exposes aria-controls while the content is
      // mounted (open) — pointing at a non-existent id when collapsed was invalid ARIA.
      await trigger.click();
      const ariaControls = await trigger.getAttribute('aria-controls');
      expect(ariaControls).toBeTruthy();
    });

    test('content has region role when expanded', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" defaultValue="item-1" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const content = component.locator('[data-slot="accordion-content"]');
      await expect(content).toHaveRole('region');
    });

    test('content has aria-labelledby pointing to trigger', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" defaultValue="item-1" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const content = component.locator('[data-slot="accordion-content"]');
      const ariaLabelledBy = await content.getAttribute('aria-labelledby');
      expect(ariaLabelledBy).toBeTruthy();
    });

    test('trigger is focusable', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const trigger = component.locator('[data-slot="accordion-trigger"]');
      await trigger.focus();
      await expect(trigger).toBeFocused();
    });
  });

  test.describe('composition', () => {
    test('renders full accordion with multiple items and content', async ({ mount, page }) => {
      await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Getting Started</AccordionTrigger>
            <AccordionContent>Follow the installation guide to get started.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>Configuration</AccordionTrigger>
            <AccordionContent>Configure your project settings here.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>FAQ</AccordionTrigger>
            <AccordionContent>Frequently asked questions and answers.</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      await expect(page.locator('[data-slot="accordion"]')).toBeVisible();
      await expect(page.locator('[data-slot="accordion-item"]')).toHaveCount(3);
      await expect(page.locator('[data-slot="accordion-trigger"]')).toHaveCount(3);
    });

    test('AccordionItem has border styling', async ({ mount }) => {
      const component = await mount(
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>Section 1</AccordionTrigger>
            <AccordionContent>Content 1</AccordionContent>
          </AccordionItem>
        </Accordion>,
      );

      const item = component.locator('[data-slot="accordion-item"]');
      await expect(item).toHaveClass(/border-b/);
    });
  });
});

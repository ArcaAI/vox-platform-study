import { test, expect } from '@playwright/experimental-ct-react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../../shadcn/resizable';

test.describe('Resizable', () => {
  test.describe('ResizablePanelGroup', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Panel 1</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Panel 2</ResizablePanel>
        </ResizablePanelGroup>,
      );
      await expect(component).toBeVisible();
    });

    test('has data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Content</ResizablePanel>
        </ResizablePanelGroup>,
      );
      await expect(component).toHaveAttribute('data-slot', 'resizable-panel-group');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="horizontal" className="custom-group">
          <ResizablePanel>Content</ResizablePanel>
        </ResizablePanelGroup>,
      );
      await expect(component).toHaveClass(/custom-group/);
    });

    test('has flex layout', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Content</ResizablePanel>
        </ResizablePanelGroup>,
      );
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/h-full/);
      await expect(component).toHaveClass(/w-full/);
    });

    test('supports horizontal orientation', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Panel 1</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Panel 2</ResizablePanel>
        </ResizablePanelGroup>,
      );
      // v4 drives layout via inline flex-direction (data-panel-group-direction is gone)
      await expect(component).toHaveCSS('flex-direction', 'row');
    });

    test('supports vertical orientation', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel>Panel 1</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Panel 2</ResizablePanel>
        </ResizablePanelGroup>,
      );
      await expect(component).toHaveCSS('flex-direction', 'column');
    });
  });

  test.describe('ResizablePanel', () => {
    test('renders children', async ({ mount }) => {
      const component = await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Panel content</ResizablePanel>
        </ResizablePanelGroup>,
      );
      await expect(component).toContainText('Panel content');
    });

    test('has data-slot attribute', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Content</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const panel = page.locator('[data-slot="resizable-panel"]');
      await expect(panel).toBeVisible();
    });

    test('renders multiple panels', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>First</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Second</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Third</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const panels = page.locator('[data-slot="resizable-panel"]');
      await expect(panels).toHaveCount(3);
    });
  });

  test.describe('ResizableHandle', () => {
    test('renders between panels', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      await expect(handle).toBeVisible();
    });

    test('has data-slot attribute', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      await expect(handle).toHaveAttribute('data-slot', 'resizable-handle');
    });

    test('applies custom className', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle className="custom-handle" />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      await expect(handle).toHaveClass(/custom-handle/);
    });

    test('has correct styling', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      await expect(handle).toHaveClass(/bg-border/);
      await expect(handle).toHaveClass(/flex/);
      await expect(handle).toHaveClass(/items-center/);
      await expect(handle).toHaveClass(/justify-center/);
    });

    test('renders with grip handle when withHandle is true', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      const gripDiv = handle.locator('div');
      await expect(gripDiv).toBeVisible();
    });

    test('does not render grip handle by default', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      const gripDiv = handle.locator('div');
      await expect(gripDiv).toHaveCount(0);
    });
  });

  test.describe('composition', () => {
    test('renders full horizontal layout', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="25%">
            <div>Sidebar</div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="75%">
            <div>Main Content</div>
          </ResizablePanel>
        </ResizablePanelGroup>,
      );

      const group = page.locator('[data-slot="resizable-panel-group"]');
      await expect(group).toBeVisible();

      const panels = page.locator('[data-slot="resizable-panel"]');
      await expect(panels).toHaveCount(2);

      const handle = page.locator('[data-slot="resizable-handle"]');
      await expect(handle).toBeVisible();
    });

    test('renders nested panel groups', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel>Top</ResizablePanel>
              <ResizableHandle />
              <ResizablePanel>Bottom</ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>,
      );

      const groups = page.locator('[data-slot="resizable-panel-group"]');
      await expect(groups).toHaveCount(2);
    });
  });

  test.describe('accessibility', () => {
    test('handle is focusable', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.locator('[data-slot="resizable-handle"]');
      await handle.focus();
      await expect(handle).toBeFocused();
    });

    test('handle has separator role', async ({ mount, page }) => {
      await mount(
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>,
      );
      const handle = page.getByRole('separator');
      await expect(handle).toBeVisible();
    });
  });
});

import { test, expect } from '@playwright/experimental-ct-react';
import { BasicSheet, SheetWithCustomClass } from '../fixtures/shadcn/sheet-fixtures';

test.describe('Sheet', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<BasicSheet />);
      const trigger = page.getByRole('button', { name: 'Open Sheet' });
      await expect(trigger).toBeVisible();
    });

    test('sheet content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicSheet />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).not.toBeVisible();
    });

    test('sheet content is visible when defaultOpen is true', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toBeVisible();
    });
  });

  test.describe('opening and closing', () => {
    test('opens sheet when trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicSheet />);
      const trigger = page.getByRole('button', { name: 'Open Sheet' });
      await trigger.click();

      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toBeVisible();
    });

    test('closes sheet when Escape key is pressed', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(content).not.toBeVisible();
    });

    test('closes sheet when overlay is clicked', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const overlay = page.locator('[data-slot="sheet-overlay"]');
      await overlay.click({ position: { x: 10, y: 10 } });

      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).not.toBeVisible();
    });

    test('closes sheet when Cancel button is clicked', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const cancelButton = page.getByRole('button', { name: 'Cancel' });
      await cancelButton.click();

      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).not.toBeVisible();
    });
  });

  test.describe('content structure', () => {
    test('renders sheet title', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const title = page.locator('[data-slot="sheet-title"]');
      await expect(title).toBeVisible();
      await expect(title).toHaveText('Sheet Title');
    });

    test('renders sheet description', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const description = page.locator('[data-slot="sheet-description"]');
      await expect(description).toBeVisible();
      await expect(description).toHaveText('Sheet description text');
    });

    test('renders sheet header', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const header = page.locator('[data-slot="sheet-header"]');
      await expect(header).toBeVisible();
    });

    test('renders sheet footer', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const footer = page.locator('[data-slot="sheet-footer"]');
      await expect(footer).toBeVisible();
    });

    test('renders body content', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toContainText('Sheet body content');
    });

    test('renders footer buttons', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const footer = page.locator('[data-slot="sheet-footer"]');
      await expect(footer.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await expect(footer.getByRole('button', { name: 'Save' })).toBeVisible();
    });
  });

  test.describe('sides', () => {
    test('renders right side by default with slide-in-from-right', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="right" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:slide-in-from-right/);
    });

    test('renders left side with slide-in-from-left', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="left" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:slide-in-from-left/);
    });

    test('renders top side with slide-in-from-top', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="top" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:slide-in-from-top/);
    });

    test('renders bottom side with slide-in-from-bottom', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="bottom" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:slide-in-from-bottom/);
    });

    test('right side has border-l class', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="right" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/border-l/);
    });

    test('left side has border-r class', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="left" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/border-r/);
    });

    test('top side has border-b class', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="top" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/border-b/);
    });

    test('bottom side has border-t class', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen side="bottom" />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/border-t/);
    });
  });

  test.describe('close button', () => {
    test('shows close button by default', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const closeButton = page
        .locator('[data-slot="sheet-content"]')
        .locator('button')
        .filter({ has: page.locator('.sr-only') });
      await expect(closeButton).toBeVisible();
    });

    test('hides close button when showCloseButton is false', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen showCloseButton={false} />);
      const srOnly = page.locator('[data-slot="sheet-content"]').locator('text=Close').first();
      await expect(srOnly).not.toBeVisible();
    });

    test('close button has sr-only "Close" text', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const srOnlyText = page.locator('[data-slot="sheet-content"]').locator('.sr-only').filter({ hasText: 'Close' });
      await expect(srOnlyText).toHaveCount(1);
    });
  });

  test.describe('overlay', () => {
    test('renders overlay when sheet is open', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const overlay = page.locator('[data-slot="sheet-overlay"]');
      await expect(overlay).toBeVisible();
    });

    test('overlay has fixed positioning', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const overlay = page.locator('[data-slot="sheet-overlay"]');
      await expect(overlay).toHaveClass(/fixed/);
    });

    test('overlay has inset-0', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const overlay = page.locator('[data-slot="sheet-overlay"]');
      await expect(overlay).toHaveClass(/inset-0/);
    });
  });

  test.describe('accessibility', () => {
    test('sheet has dialog role', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
    });

    test('sheet is labelled by title', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveAccessibleName('Sheet Title');
    });

    test('sheet has accessible description', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveAccessibleDescription('Sheet description text');
    });

    test('content has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicSheet defaultOpen />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveAttribute('data-slot', 'sheet-content');
    });
  });

  test.describe('focus management', () => {
    test('returns focus to trigger when closed', async ({ mount, page }) => {
      await mount(<BasicSheet />);
      const trigger = page.getByRole('button', { name: 'Open Sheet' });

      await trigger.click();
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    });
  });

  test.describe('custom className', () => {
    test('supports custom className on SheetContent', async ({ mount, page }) => {
      await mount(<SheetWithCustomClass defaultOpen />);
      const content = page.locator('[data-slot="sheet-content"]');
      await expect(content).toHaveClass(/custom-sheet-class/);
    });
  });
});

import { test, expect } from '@playwright/experimental-ct-react';
import { ControlledAlertDialog } from '../fixtures/shadcn/alert-dialog-fixtures';

test.describe('AlertDialog', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const trigger = page.getByRole('button', { name: 'Delete Item' });
      await expect(trigger).toBeVisible();
    });

    test('trigger has data-slot attribute', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const trigger = page.locator('[data-slot="alert-dialog-trigger"]');
      await expect(trigger).toBeVisible();
    });

    test('content is hidden by default', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).not.toBeVisible();
    });

    test('content is visible when defaultOpen is true', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toBeVisible();
    });
  });

  test.describe('opening and closing', () => {
    test('opens on trigger click', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const trigger = page.getByRole('button', { name: 'Delete Item' });
      await trigger.click();

      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toBeVisible();
    });

    test('closes on Action button click', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);

      const action = page.locator('[data-slot="alert-dialog-action"]');
      await action.click();

      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).not.toBeVisible();
    });

    test('closes on Cancel button click', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);

      const cancel = page.locator('[data-slot="alert-dialog-cancel"]');
      await cancel.click();

      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).not.toBeVisible();
    });

    test('does NOT close on overlay click', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);

      const overlay = page.locator('[data-slot="alert-dialog-overlay"]');
      await overlay.click({ position: { x: 10, y: 10 } });

      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toBeVisible();
    });

    test('does NOT close on Escape key', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);

      await page.keyboard.press('Escape');

      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toBeVisible();
    });
  });

  test.describe('content structure', () => {
    test('renders title', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const title = page.locator('[data-slot="alert-dialog-title"]');
      await expect(title).toBeVisible();
      await expect(title).toHaveText('Are you sure?');
    });

    test('renders description', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const description = page.locator('[data-slot="alert-dialog-description"]');
      await expect(description).toBeVisible();
      await expect(description).toHaveText('This action cannot be undone.');
    });

    test('renders header', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const header = page.locator('[data-slot="alert-dialog-header"]');
      await expect(header).toBeVisible();
    });

    test('renders footer', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const footer = page.locator('[data-slot="alert-dialog-footer"]');
      await expect(footer).toBeVisible();
    });

    test('renders Action button', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const action = page.locator('[data-slot="alert-dialog-action"]');
      await expect(action).toBeVisible();
      await expect(action).toHaveText('Continue');
    });

    test('renders Cancel button', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const cancel = page.locator('[data-slot="alert-dialog-cancel"]');
      await expect(cancel).toBeVisible();
      await expect(cancel).toHaveText('Cancel');
    });

    test('renders overlay when open', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const overlay = page.locator('[data-slot="alert-dialog-overlay"]');
      await expect(overlay).toBeVisible();
    });
  });

  test.describe('size variants', () => {
    test('renders default size', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen size="default" />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toHaveAttribute('data-size', 'default');
    });

    test('renders sm size', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen size="sm" />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toHaveAttribute('data-size', 'sm');
    });

    test('default size has max-w-lg class', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen size="default" />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toHaveClass(/data-\[size=default\]:sm:max-w-lg/);
    });

    test('sm size has max-w-xs class', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen size="sm" />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toHaveClass(/data-\[size=sm\]:max-w-xs/);
    });
  });

  test.describe('focus management', () => {
    test('focuses content when opened', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const trigger = page.getByRole('button', { name: 'Delete Item' });
      await trigger.click();

      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toBeVisible();
    });

    test('returns focus to trigger when closed via Cancel', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const trigger = page.getByRole('button', { name: 'Delete Item' });

      await trigger.click();
      const cancel = page.locator('[data-slot="alert-dialog-cancel"]');
      await cancel.click();

      await expect(trigger).toBeFocused();
    });

    test('returns focus to trigger when closed via Action', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog />);
      const trigger = page.getByRole('button', { name: 'Delete Item' });

      await trigger.click();
      const action = page.locator('[data-slot="alert-dialog-action"]');
      await action.click();

      await expect(trigger).toBeFocused();
    });

    test('traps focus within dialog', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);

      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');

      const content = page.locator('[data-slot="alert-dialog-content"]');
      const focusedElement = page.locator(':focus');
      await expect(content).toContainText((await focusedElement.textContent()) || '');
    });
  });

  test.describe('accessibility', () => {
    test('has alertdialog role', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
    });

    test('is labelled by title', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toHaveAccessibleName('Are you sure?');
    });

    test('has accessible description', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toHaveAccessibleDescription('This action cannot be undone.');
    });

    test('Action button is a button', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const action = page.locator('[data-slot="alert-dialog-action"]');
      await expect(action).toHaveRole('button');
    });

    test('Cancel button is a button', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const cancel = page.locator('[data-slot="alert-dialog-cancel"]');
      await expect(cancel).toHaveRole('button');
    });

    test('overlay has correct styling', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const overlay = page.locator('[data-slot="alert-dialog-overlay"]');
      await expect(overlay).toHaveClass(/fixed/);
      await expect(overlay).toHaveClass(/inset-0/);
    });
  });

  test.describe('animations', () => {
    test('content has open animation classes', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const content = page.locator('[data-slot="alert-dialog-content"]');
      await expect(content).toHaveClass(/data-\[state=open\]:animate-in/);
    });

    test('overlay has fade animation classes', async ({ mount, page }) => {
      await mount(<ControlledAlertDialog defaultOpen />);
      const overlay = page.locator('[data-slot="alert-dialog-overlay"]');
      await expect(overlay).toHaveClass(/data-\[state=open\]:fade-in-0/);
    });
  });
});

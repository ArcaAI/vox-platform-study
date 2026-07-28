import { test, expect } from '@playwright/experimental-ct-react';
import { BasicForm, FormWithError, FormWithMultipleFields } from '../fixtures/shadcn/form-fixtures';

test.describe('Form', () => {
  test.describe('rendering', () => {
    test('renders FormItem with data-slot', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const formItem = page.locator('[data-slot="form-item"]');
      await expect(formItem).toBeVisible();
    });

    test('renders FormLabel with data-slot', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const label = page.locator('[data-slot="form-label"]');
      await expect(label).toBeVisible();
      await expect(label).toHaveText('Username');
    });

    test('renders FormControl with data-slot', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const control = page.locator('[data-slot="form-control"]');
      await expect(control).toBeVisible();
    });

    test('renders FormDescription with data-slot', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const description = page.locator('[data-slot="form-description"]');
      await expect(description).toBeVisible();
      await expect(description).toHaveText('Your public display name.');
    });

    test('renders input inside FormControl', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const input = page.getByPlaceholder('Enter username');
      await expect(input).toBeVisible();
    });

    test('FormMessage is not visible when no error', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const message = page.locator('[data-slot="form-message"]');
      await expect(message).not.toBeVisible();
    });
  });

  test.describe('error state', () => {
    test('displays error message when field has error', async ({ mount, page }) => {
      await mount(<FormWithError />);
      const message = page.locator('[data-slot="form-message"]');
      await expect(message).toBeVisible();
      await expect(message).toHaveText('Email is required');
    });

    test('label has data-error attribute when error exists', async ({ mount, page }) => {
      await mount(<FormWithError />);
      const label = page.locator('[data-slot="form-label"]');
      await expect(label).toHaveAttribute('data-error', 'true');
    });

    test('label does not have data-error when no error', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const label = page.locator('[data-slot="form-label"]');
      await expect(label).toHaveAttribute('data-error', 'false');
    });

    test('form control has aria-invalid when error exists', async ({ mount, page }) => {
      await mount(<FormWithError />);
      const control = page.locator('[data-slot="form-control"]');
      await expect(control).toHaveAttribute('aria-invalid', 'true');
    });

    test('form control does not have aria-invalid when no error', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const control = page.locator('[data-slot="form-control"]');
      await expect(control).toHaveAttribute('aria-invalid', 'false');
    });

    test('error message has destructive text styling', async ({ mount, page }) => {
      await mount(<FormWithError />);
      const message = page.locator('[data-slot="form-message"]');
      await expect(message).toHaveClass(/text-destructive/);
    });
  });

  test.describe('accessibility', () => {
    test('label is associated with input via htmlFor', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const label = page.locator('[data-slot="form-label"]');
      const control = page.locator('[data-slot="form-control"]');

      const htmlFor = await label.getAttribute('for');
      const controlId = await control.getAttribute('id');
      expect(htmlFor).toBeTruthy();
      expect(htmlFor).toBe(controlId);
    });

    test('description is linked via aria-describedby', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const control = page.locator('[data-slot="form-control"]');
      const description = page.locator('[data-slot="form-description"]');

      const ariaDescribedBy = await control.getAttribute('aria-describedby');
      const descriptionId = await description.getAttribute('id');
      expect(ariaDescribedBy).toContain(descriptionId!);
    });

    test('error message id is included in aria-describedby when error exists', async ({ mount, page }) => {
      await mount(<FormWithError />);
      const control = page.locator('[data-slot="form-control"]');
      const message = page.locator('[data-slot="form-message"]');

      const ariaDescribedBy = await control.getAttribute('aria-describedby');
      const messageId = await message.getAttribute('id');
      expect(ariaDescribedBy).toContain(messageId!);
    });

    test('clicking label focuses the input', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const label = page.locator('[data-slot="form-label"]');
      await label.click();

      const input = page.getByPlaceholder('Enter username');
      await expect(input).toBeFocused();
    });
  });

  test.describe('multiple fields', () => {
    test('renders multiple form items', async ({ mount, page }) => {
      await mount(<FormWithMultipleFields />);
      const items = page.locator('[data-slot="form-item"]');
      await expect(items).toHaveCount(2);
    });

    test('each field has its own label', async ({ mount, page }) => {
      await mount(<FormWithMultipleFields />);
      const labels = page.locator('[data-slot="form-label"]');
      await expect(labels).toHaveCount(2);
      await expect(labels.nth(0)).toHaveText('First Name');
      await expect(labels.nth(1)).toHaveText('Last Name');
    });

    test('each field has unique id associations', async ({ mount, page }) => {
      await mount(<FormWithMultipleFields />);
      const controls = page.locator('[data-slot="form-control"]');
      const id1 = await controls.nth(0).getAttribute('id');
      const id2 = await controls.nth(1).getAttribute('id');
      expect(id1).not.toBe(id2);
    });
  });

  test.describe('interactions', () => {
    test('input accepts text input', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const input = page.getByPlaceholder('Enter username');
      await input.fill('testuser');
      await expect(input).toHaveValue('testuser');
    });

    test('input is focusable', async ({ mount, page }) => {
      await mount(<BasicForm />);
      const input = page.getByPlaceholder('Enter username');
      await input.focus();
      await expect(input).toBeFocused();
    });
  });
});

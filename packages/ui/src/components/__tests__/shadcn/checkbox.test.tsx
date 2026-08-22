import { test, expect } from '@playwright/experimental-ct-react';
import { Checkbox } from '../../shadcn/checkbox';

test.describe('Checkbox', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeVisible();
      await expect(checkbox).toHaveAttribute('data-slot', 'checkbox');
    });

    test('renders as a button element', async ({ mount, page }) => {
      await mount(<Checkbox />);
      await expect(page.getByRole('checkbox')).toHaveRole('checkbox');
    });

    test('applies custom className', async ({ mount, page }) => {
      await mount(<Checkbox className="custom-checkbox" />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveClass(/custom-checkbox/);
    });

    test('has correct default styling', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveClass(/size-4/);
      await expect(checkbox).toHaveClass(/rounded-xs/);
      await expect(checkbox).toHaveClass(/border/);
    });
  });

  test.describe('states', () => {
    test('is unchecked by default', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    });

    test('can be checked by default', async ({ mount, page }) => {
      await mount(<Checkbox defaultChecked />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toHaveAttribute('data-state', 'checked');
    });

    test('supports controlled checked state', async ({ mount, page }) => {
      await mount(<Checkbox checked />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeChecked();
    });

    test('handles disabled state', async ({ mount, page }) => {
      await mount(<Checkbox disabled />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeDisabled();
      await expect(checkbox).toHaveClass(/disabled:opacity-50/);
    });

    test('handles required state', async ({ mount, page }) => {
      await mount(<Checkbox required />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveAttribute('aria-required', 'true');
    });
  });

  test.describe('interactions', () => {
    test('toggles when clicked', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');

      await expect(checkbox).not.toBeChecked();
      await checkbox.click();
      await expect(checkbox).toBeChecked();
      await checkbox.click();
      await expect(checkbox).not.toBeChecked();
    });

    test('toggles with Space key', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');

      await checkbox.focus();
      await expect(checkbox).not.toBeChecked();
      await checkbox.press(' ');
      await expect(checkbox).toBeChecked();
    });

    test('does not toggle when disabled', async ({ mount, page }) => {
      await mount(<Checkbox disabled />);
      const checkbox = page.getByRole('checkbox');
      await checkbox.click({ force: true });
      await expect(checkbox).not.toBeChecked();
    });

    test('calls onCheckedChange when toggled', async ({ mount, page }) => {
      let checked: boolean | 'indeterminate' = false;
      await mount(<Checkbox onCheckedChange={(value) => (checked = value)} />);
      const checkbox = page.getByRole('checkbox');

      await checkbox.click();
      expect(checked).toBe(true);

      await checkbox.click();
      expect(checked).toBe(false);
    });
  });

  test.describe('indeterminate state', () => {
    test('supports indeterminate state', async ({ mount, page }) => {
      await mount(<Checkbox checked="indeterminate" />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveAttribute('data-state', 'indeterminate');
    });
  });

  test.describe('focus', () => {
    test('is focusable when enabled', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');
      await checkbox.focus();
      await expect(checkbox).toBeFocused();
    });

    test('is not focusable when disabled', async ({ mount, page }) => {
      await mount(<Checkbox disabled />);
      const checkbox = page.getByRole('checkbox');
      await checkbox.focus();
      await expect(checkbox).not.toBeFocused();
    });

    test('shows focus ring on focus', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveClass(/focus-visible:ring/);
    });
  });

  test.describe('indicator', () => {
    test('shows check indicator when checked', async ({ mount, page }) => {
      await mount(<Checkbox defaultChecked />);
      const indicator = page.locator('[data-slot="checkbox-indicator"]');
      await expect(indicator).toBeVisible();
    });

    test('hides indicator when unchecked', async ({ mount, page }) => {
      await mount(<Checkbox />);
      const indicator = page.locator('[data-slot="checkbox-indicator"]');
      // When unchecked, indicator has no content visible
      await expect(indicator).not.toBeVisible();
    });
  });

  test.describe('accessibility', () => {
    test('has checkbox role', async ({ mount, page }) => {
      await mount(<Checkbox />);
      await expect(page.getByRole('checkbox')).toHaveRole('checkbox');
    });

    test('supports aria-label', async ({ mount, page }) => {
      await mount(<Checkbox aria-label="Accept terms" />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveAccessibleName('Accept terms');
    });

    test('supports aria-describedby', async ({ mount, page }) => {
      await mount(
        <div>
          <Checkbox aria-describedby="terms-description" />
          <span id="terms-description">You must accept the terms</span>
        </div>,
      );
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveAttribute('aria-describedby', 'terms-description');
    });

    test('supports id for label association', async ({ mount, page }) => {
      await mount(
        <div>
          <Checkbox id="terms-checkbox" />
          <label htmlFor="terms-checkbox">Accept terms</label>
        </div>,
      );
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveAttribute('id', 'terms-checkbox');
    });

    test('indicates checked state to assistive technologies', async ({ mount, page }) => {
      await mount(<Checkbox defaultChecked />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeChecked();
    });

    test('indicates disabled state to assistive technologies', async ({ mount, page }) => {
      await mount(<Checkbox disabled />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeDisabled();
    });

    test('supports aria-invalid for error state', async ({ mount, page }) => {
      await mount(<Checkbox aria-invalid="true" />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveAttribute('aria-invalid', 'true');
      await expect(checkbox).toHaveClass(/aria-invalid:border-destructive/);
    });
  });

  test.describe('styling', () => {
    test('changes background when checked', async ({ mount, page }) => {
      await mount(<Checkbox defaultChecked />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveClass(/data-\[state=checked\]:bg-primary/);
    });

    test('changes border when checked', async ({ mount, page }) => {
      await mount(<Checkbox defaultChecked />);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toHaveClass(/data-\[state=checked\]:border-primary/);
    });
  });

  test.describe('form integration', () => {
    test('supports name attribute', async ({ mount, page }) => {
      await mount(
        <form>
          <Checkbox name="terms" />
        </form>,
      );
      const hiddenInput = page.locator('input[name="terms"]');
      await expect(hiddenInput).toHaveAttribute('name', 'terms');
    });

    test('supports value attribute', async ({ mount, page }) => {
      await mount(
        <form>
          <Checkbox value="agreed" />
        </form>,
      );
      const hiddenInput = page.locator('input[value="agreed"]');
      await expect(hiddenInput).toHaveAttribute('value', 'agreed');
    });
  });

  test.describe('with label', () => {
    test('clicking label toggles checkbox', async ({ mount, page }) => {
      await mount(
        <div className="flex items-center gap-2">
          <Checkbox id="label-test" />
          <label htmlFor="label-test">Click me</label>
        </div>,
      );

      const checkbox = page.getByRole('checkbox');
      const label = page.getByText('Click me');

      await expect(checkbox).not.toBeChecked();
      await label.click();
      await expect(checkbox).toBeChecked();
    });
  });
});

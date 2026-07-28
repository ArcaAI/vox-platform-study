import { test, expect } from '@playwright/experimental-ct-react';
import { ThemeToggle } from '../../custom/theme-toggle';

test.describe('ThemeToggle', () => {
  test.describe('rendering', () => {
    test('renders as a button', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await expect(component).toHaveRole('button');
      await expect(component).toBeVisible();
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<ThemeToggle className="custom-toggle" />);
      await expect(component).toHaveClass(/custom-toggle/);
    });

    test('renders with ghost variant styling', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await expect(component).toHaveAttribute('data-variant', 'ghost');
    });

    test('renders with icon size', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await expect(component).toHaveAttribute('data-size', 'icon');
    });
  });

  test.describe('aria-label', () => {
    test('has descriptive aria-label', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      const label = await component.getAttribute('aria-label');
      expect(label).toMatch(/switch to (light|dark) mode/i);
    });
  });

  test.describe('interactions', () => {
    test('is clickable', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await component.click();
      await expect(component).toBeVisible();
    });

    test('is keyboard accessible', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await component.focus();
      await expect(component).toBeFocused();
      await component.press('Enter');
      await expect(component).toBeVisible();
    });

    test('toggles aria-label on click', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      const initialLabel = await component.getAttribute('aria-label');
      await component.click();
      const newLabel = await component.getAttribute('aria-label');
      expect(initialLabel).not.toBe(newLabel);
    });
  });

  test.describe('icons', () => {
    test('contains sun and moon icons', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      const svgs = component.locator('svg');
      await expect(svgs).toHaveCount(2);
    });
  });

  test.describe('accessibility', () => {
    test('button is focusable', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await component.focus();
      await expect(component).toBeFocused();
    });

    test('has button role', async ({ mount }) => {
      const component = await mount(<ThemeToggle />);
      await expect(component).toHaveRole('button');
    });
  });
});

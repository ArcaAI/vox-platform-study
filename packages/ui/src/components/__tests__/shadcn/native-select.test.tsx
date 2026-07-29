import { test, expect } from '@playwright/experimental-ct-react';
import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from '../../shadcn/native-select';

test.describe('NativeSelect', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(
        <NativeSelect>
          <NativeSelectOption value="">Select</NativeSelectOption>
          <NativeSelectOption value="a">Option A</NativeSelectOption>
        </NativeSelect>,
      );
      await expect(component).toBeVisible();
      await expect(component).toHaveAttribute('data-slot', 'native-select');
    });

    test('renders as a select element', async ({ mount }) => {
      const component = await mount(
        <NativeSelect>
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>,
      );
      await expect(component).toHaveRole('combobox');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <NativeSelect className="custom-class">
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>,
      );
      await expect(component).toHaveClass(/custom-class/);
    });

    test('renders options with correct values', async ({ mount }) => {
      const component = await mount(
        <NativeSelect>
          <NativeSelectOption value="">Pick one</NativeSelectOption>
          <NativeSelectOption value="todo">Todo</NativeSelectOption>
          <NativeSelectOption value="done">Done</NativeSelectOption>
        </NativeSelect>,
      );
      const options = component.locator('option');
      await expect(options).toHaveCount(3);
    });
  });

  test.describe('option groups', () => {
    test('renders optgroup with label', async ({ mount }) => {
      const component = await mount(
        <NativeSelect>
          <NativeSelectOptGroup label="Fruits">
            <NativeSelectOption value="apple">Apple</NativeSelectOption>
            <NativeSelectOption value="banana">Banana</NativeSelectOption>
          </NativeSelectOptGroup>
        </NativeSelect>,
      );
      const group = component.locator('optgroup');
      await expect(group).toHaveAttribute('label', 'Fruits');
    });
  });

  test.describe('states', () => {
    test('handles disabled state', async ({ mount }) => {
      const component = await mount(
        <NativeSelect disabled>
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>,
      );
      await expect(component).toBeDisabled();
    });

    test('supports aria-invalid for validation', async ({ mount }) => {
      const component = await mount(
        <NativeSelect aria-invalid="true">
          <NativeSelectOption value="">Error</NativeSelectOption>
        </NativeSelect>,
      );
      await expect(component).toHaveAttribute('aria-invalid', 'true');
    });
  });

  test.describe('interactions', () => {
    test('allows selecting an option', async ({ mount }) => {
      const component = await mount(
        <NativeSelect>
          <NativeSelectOption value="">Pick</NativeSelectOption>
          <NativeSelectOption value="todo">Todo</NativeSelectOption>
          <NativeSelectOption value="done">Done</NativeSelectOption>
        </NativeSelect>,
      );
      await component.selectOption('done');
      await expect(component).toHaveValue('done');
    });
  });

  test.describe('accessibility', () => {
    test('is focusable', async ({ mount }) => {
      const component = await mount(
        <NativeSelect>
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>,
      );
      await component.focus();
      await expect(component).toBeFocused();
    });

    test('is not focusable when disabled', async ({ mount }) => {
      const component = await mount(
        <NativeSelect disabled>
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>,
      );
      await component.focus();
      await expect(component).not.toBeFocused();
    });
  });
});

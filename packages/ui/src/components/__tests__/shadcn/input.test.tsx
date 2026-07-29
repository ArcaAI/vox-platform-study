import { test, expect } from '@playwright/experimental-ct-react';
import { Input } from '../../shadcn/input';
import { InputChangeTracker, InputFocusBlurTracker, InputKeyTracker } from '../fixtures/shadcn/input-fixtures';

test.describe('Input', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Input />);
      await expect(component).toBeVisible();
      await expect(component).toHaveAttribute('data-slot', 'input');
    });

    test('renders as input element', async ({ mount }) => {
      const component = await mount(<Input />);
      await expect(component).toHaveRole('textbox');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Input className="custom-class" />);
      await expect(component).toHaveClass(/custom-class/);
    });
  });

  test.describe('types', () => {
    test('renders text input by default', async ({ mount }) => {
      const component = await mount(<Input />);
      await expect(component).toHaveAttribute('data-slot', 'input');
    });

    test('renders email input', async ({ mount }) => {
      const component = await mount(<Input type="email" />);
      await expect(component).toHaveAttribute('type', 'email');
    });

    test('renders password input', async ({ mount }) => {
      const component = await mount(<Input type="password" />);
      await expect(component).toHaveAttribute('type', 'password');
    });

    test('renders number input', async ({ mount }) => {
      const component = await mount(<Input type="number" />);
      await expect(component).toHaveAttribute('type', 'number');
    });

    test('renders search input', async ({ mount }) => {
      const component = await mount(<Input type="search" />);
      await expect(component).toHaveAttribute('type', 'search');
    });

    test('renders tel input', async ({ mount }) => {
      const component = await mount(<Input type="tel" />);
      await expect(component).toHaveAttribute('type', 'tel');
    });

    test('renders url input', async ({ mount }) => {
      const component = await mount(<Input type="url" />);
      await expect(component).toHaveAttribute('type', 'url');
    });
  });

  test.describe('states', () => {
    test('handles disabled state', async ({ mount }) => {
      const component = await mount(<Input disabled />);
      await expect(component).toBeDisabled();
      await expect(component).toHaveClass(/disabled:opacity-50/);
    });

    test('handles readonly state', async ({ mount }) => {
      const component = await mount(<Input readOnly />);
      await expect(component).toHaveAttribute('readonly', '');
    });

    test('handles required state', async ({ mount }) => {
      const component = await mount(<Input required />);
      await expect(component).toHaveAttribute('required', '');
    });

    test('is focusable when enabled', async ({ mount }) => {
      const component = await mount(<Input />);
      await component.focus();
      await expect(component).toBeFocused();
    });

    test('is not interactable when disabled', async ({ mount }) => {
      const component = await mount(<Input disabled />);
      await component.focus();
      await expect(component).not.toBeFocused();
    });
  });

  test.describe('value handling', () => {
    test('displays initial value', async ({ mount }) => {
      const component = await mount(<Input defaultValue="initial value" />);
      await expect(component).toHaveValue('initial value');
    });

    test('allows typing in the input', async ({ mount }) => {
      const component = await mount(<Input />);
      await component.fill('typed text');
      await expect(component).toHaveValue('typed text');
    });

    test('clears value when filled with empty string', async ({ mount }) => {
      const component = await mount(<Input defaultValue="initial" />);
      await component.fill('');
      await expect(component).toHaveValue('');
    });

    test('handles controlled value', async ({ mount }) => {
      const component = await mount(<Input value="controlled" readOnly />);
      await expect(component).toHaveValue('controlled');
    });
  });

  test.describe('placeholder', () => {
    test('displays placeholder text', async ({ mount }) => {
      const component = await mount(<Input placeholder="Enter your name" />);
      await expect(component).toHaveAttribute('placeholder', 'Enter your name');
    });

    test('hides placeholder when value is entered', async ({ mount }) => {
      const component = await mount(<Input placeholder="Enter text" />);
      await component.fill('some text');
      await expect(component).toHaveValue('some text');
    });
  });

  test.describe('interactions', () => {
    test('handles change events', async ({ mount, page }) => {
      await mount(<InputChangeTracker />);
      const input = page.getByTestId('input');
      await input.fill('test');
      await expect(page.getByTestId('change-value')).toHaveText('test');
    });

    test('handles focus events', async ({ mount, page }) => {
      await mount(<InputFocusBlurTracker />);
      const input = page.getByTestId('input');
      await input.focus();
      await expect(page.getByTestId('focus-status')).toHaveText('focused');
    });

    test('handles blur events', async ({ mount, page }) => {
      await mount(<InputFocusBlurTracker />);
      const input = page.getByTestId('input');
      await input.focus();
      await input.blur();
      await expect(page.getByTestId('focus-status')).toHaveText('blurred');
    });

    test('handles keyboard events', async ({ mount, page }) => {
      await mount(<InputKeyTracker />);
      const input = page.getByTestId('input');
      await input.focus();
      await input.press('Enter');
      await expect(page.getByTestId('key-value')).toHaveText('Enter');
    });
  });

  test.describe('validation', () => {
    test('supports aria-invalid for error state', async ({ mount }) => {
      const component = await mount(<Input aria-invalid="true" />);
      await expect(component).toHaveAttribute('aria-invalid', 'true');
      await expect(component).toHaveClass(/aria-invalid:border-destructive/);
    });

    test('supports min and max for number input', async ({ mount }) => {
      const component = await mount(<Input type="number" min={0} max={100} />);
      await expect(component).toHaveAttribute('min', '0');
      await expect(component).toHaveAttribute('max', '100');
    });

    test('supports minLength and maxLength', async ({ mount }) => {
      const component = await mount(<Input minLength={3} maxLength={10} />);
      await expect(component).toHaveAttribute('minlength', '3');
      await expect(component).toHaveAttribute('maxlength', '10');
    });

    test('supports pattern attribute', async ({ mount }) => {
      const component = await mount(<Input pattern="[A-Za-z]+" />);
      await expect(component).toHaveAttribute('pattern', '[A-Za-z]+');
    });
  });

  test.describe('accessibility', () => {
    test('supports aria-label', async ({ mount }) => {
      const component = await mount(<Input aria-label="Email address" />);
      await expect(component).toHaveAccessibleName('Email address');
    });

    test('supports aria-describedby', async ({ mount }) => {
      const component = await mount(
        <div>
          <Input aria-describedby="hint" />
          <span id="hint">Enter a valid email</span>
        </div>,
      );
      const input = component.getByRole('textbox');
      await expect(input).toHaveAttribute('aria-describedby', 'hint');
    });

    test('supports id for label association', async ({ mount }) => {
      const component = await mount(
        <div>
          <label htmlFor="test-input">Name</label>
          <Input id="test-input" />
        </div>,
      );
      const input = component.getByRole('textbox');
      await expect(input).toHaveAttribute('id', 'test-input');
      await expect(input).toHaveAccessibleName('Name');
    });

    test('indicates disabled state to assistive technologies', async ({ mount }) => {
      const component = await mount(<Input disabled />);
      await expect(component).toBeDisabled();
    });

    test('indicates required state to assistive technologies', async ({ mount }) => {
      const component = await mount(<Input required aria-label="Required field" />);
      await expect(component).toHaveAttribute('required', '');
    });
  });

  test.describe('file input', () => {
    test('renders file input', async ({ mount }) => {
      const component = await mount(<Input type="file" />);
      await expect(component).toHaveAttribute('type', 'file');
    });

    test('supports accept attribute for file types', async ({ mount }) => {
      const component = await mount(<Input type="file" accept="image/*,.pdf" />);
      await expect(component).toHaveAttribute('accept', 'image/*,.pdf');
    });

    test('supports multiple files', async ({ mount }) => {
      const component = await mount(<Input type="file" multiple />);
      await expect(component).toHaveAttribute('multiple', '');
    });
  });
});

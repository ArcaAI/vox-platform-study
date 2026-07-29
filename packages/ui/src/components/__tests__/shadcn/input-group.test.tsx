import { test, expect } from '@playwright/experimental-ct-react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea, InputGroupText } from '../../shadcn/input-group';

test.describe('InputGroup', () => {
  test.describe('rendering', () => {
    test('renders InputGroup with data-slot', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput placeholder="Enter text" />
        </InputGroup>,
      );
      const group = page.locator('[data-slot="input-group"]');
      await expect(group).toBeVisible();
      await expect(group).toHaveAttribute('data-slot', 'input-group');
    });

    test('InputGroup has role="group"', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput />
        </InputGroup>,
      );
      const group = page.locator('[data-slot="input-group"]');
      await expect(group).toHaveRole('group');
    });

    test('renders InputGroupInput with data-slot', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput placeholder="Type here" />
        </InputGroup>,
      );
      const input = page.locator('[data-slot="input-group-control"]');
      await expect(input).toBeVisible();
    });

    test('renders InputGroupTextarea with data-slot', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupTextarea placeholder="Enter message" />
        </InputGroup>,
      );
      const textarea = page.locator('[data-slot="input-group-control"]');
      await expect(textarea).toBeVisible();
    });
  });

  test.describe('InputGroupAddon', () => {
    test('renders addon with data-slot', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>$</InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toBeVisible();
    });

    test('addon defaults to inline-start alignment', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>$</InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toHaveAttribute('data-align', 'inline-start');
    });

    test('renders addon with inline-end alignment', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput />
          <InputGroupAddon align="inline-end">.com</InputGroupAddon>
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toHaveAttribute('data-align', 'inline-end');
    });

    test('renders addon with block-start alignment', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon align="block-start">Label</InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toHaveAttribute('data-align', 'block-start');
    });

    test('renders addon with block-end alignment', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput />
          <InputGroupAddon align="block-end">Helper text</InputGroupAddon>
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toHaveAttribute('data-align', 'block-end');
    });

    test('addon has role="group"', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>$</InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toHaveRole('group');
    });
  });

  test.describe('InputGroupButton', () => {
    test('renders button inside group', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput />
          <InputGroupAddon align="inline-end">
            <InputGroupButton>Search</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>,
      );
      const button = page.getByRole('button', { name: 'Search' });
      await expect(button).toBeVisible();
    });

    test('button has type="button" by default', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>
            <InputGroupButton>Go</InputGroupButton>
          </InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const button = page.getByRole('button', { name: 'Go' });
      await expect(button).toHaveAttribute('type', 'button');
    });

    test('button is clickable', async ({ mount, page }) => {
      let clicked = false;
      await mount(
        <InputGroup>
          <InputGroupAddon>
            <InputGroupButton onClick={() => (clicked = true)}>Click</InputGroupButton>
          </InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const button = page.getByRole('button', { name: 'Click' });
      await button.click();
    });
  });

  test.describe('InputGroupText', () => {
    test('renders text element', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>https://</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const text = page.getByText('https://');
      await expect(text).toBeVisible();
    });

    test('text has muted foreground styling', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>@</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput />
        </InputGroup>,
      );
      const addon = page.locator('[data-slot="input-group-addon"]');
      await expect(addon).toHaveClass(/text-muted-foreground/);
    });
  });

  test.describe('composition', () => {
    test('renders addon + input + button composition', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput placeholder="Amount" />
          <InputGroupAddon align="inline-end">
            <InputGroupButton>Submit</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>,
      );
      const group = page.locator('[data-slot="input-group"]');
      await expect(group).toBeVisible();
      await expect(page.getByPlaceholder('Amount')).toBeVisible();
      await expect(page.getByText('$')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
    });

    test('renders multiple addons', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>https://</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput placeholder="domain" />
          <InputGroupAddon align="inline-end">
            <InputGroupText>.com</InputGroupText>
          </InputGroupAddon>
        </InputGroup>,
      );
      const addons = page.locator('[data-slot="input-group-addon"]');
      await expect(addons).toHaveCount(2);
    });
  });

  test.describe('custom className', () => {
    test('applies custom className to InputGroup', async ({ mount, page }) => {
      await mount(
        <InputGroup className="custom-group">
          <InputGroupInput />
        </InputGroup>,
      );
      const group = page.locator('[data-slot="input-group"]');
      await expect(group).toHaveClass(/custom-group/);
    });

    test('applies custom className to InputGroupInput', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput className="custom-input" />
        </InputGroup>,
      );
      const input = page.locator('[data-slot="input-group-control"]');
      await expect(input).toHaveClass(/custom-input/);
    });
  });

  test.describe('interactions', () => {
    test('input is focusable', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput placeholder="Focus me" />
        </InputGroup>,
      );
      const input = page.getByPlaceholder('Focus me');
      await input.focus();
      await expect(input).toBeFocused();
    });

    test('input accepts text', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupInput placeholder="Type here" />
        </InputGroup>,
      );
      const input = page.getByPlaceholder('Type here');
      await input.fill('Hello World');
      await expect(input).toHaveValue('Hello World');
    });

    test('textarea accepts text', async ({ mount, page }) => {
      await mount(
        <InputGroup>
          <InputGroupTextarea placeholder="Enter message" />
        </InputGroup>,
      );
      const textarea = page.getByPlaceholder('Enter message');
      await textarea.fill('Multi-line text');
      await expect(textarea).toHaveValue('Multi-line text');
    });
  });
});

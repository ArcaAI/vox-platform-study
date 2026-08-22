import { test, expect } from '@playwright/experimental-ct-react';
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from '../../shadcn/button-group';
import { Button } from '../../shadcn/button';

test.describe('ButtonGroup', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveAttribute('data-slot', 'button-group');
    });

    test('renders children buttons', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
          <Button>Third</Button>
        </ButtonGroup>,
      );
      const buttons = component.getByRole('button');
      await expect(buttons).toHaveCount(3);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup className="custom-group">
          <Button>Action</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveClass(/custom-group/);
    });

    test('has flex layout', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveClass(/flex/);
    });

    test('has w-fit width', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveClass(/w-fit/);
    });
  });

  test.describe('role', () => {
    test('has role="group"', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveRole('group');
    });
  });

  test.describe('orientation', () => {
    test('defaults to horizontal orientation', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).not.toHaveClass(/flex-col/);
    });

    test('renders horizontal orientation explicitly', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup orientation="horizontal">
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveAttribute('data-orientation', 'horizontal');
    });

    test('renders vertical orientation', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup orientation="vertical">
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveAttribute('data-orientation', 'vertical');
    });

    test('vertical orientation has flex-col class', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup orientation="vertical">
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveClass(/flex-col/);
    });

    test('horizontal orientation does not have flex-col', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup orientation="horizontal">
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).not.toHaveClass(/flex-col/);
    });
  });

  test.describe('ButtonGroupSeparator', () => {
    test('renders separator with data-slot', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <ButtonGroupSeparator />
          <Button>Second</Button>
        </ButtonGroup>,
      );
      const separator = component.locator('[data-slot="button-group-separator"]');
      await expect(separator).toBeVisible();
    });

    test('separator defaults to vertical orientation', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <ButtonGroupSeparator />
          <Button>Second</Button>
        </ButtonGroup>,
      );
      const separator = component.locator('[data-slot="button-group-separator"]');
      await expect(separator).toHaveAttribute('data-orientation', 'vertical');
    });

    test('applies custom className to separator', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <ButtonGroupSeparator className="custom-sep" />
          <Button>Second</Button>
        </ButtonGroup>,
      );
      const separator = component.locator('[data-slot="button-group-separator"]');
      await expect(separator).toHaveClass(/custom-sep/);
    });

    test('separator has separator role', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <ButtonGroupSeparator />
          <Button>Second</Button>
        </ButtonGroup>,
      );
      const separator = component.locator('[data-slot="button-group-separator"]');
      await expect(separator).toHaveRole('none');
    });

    test('renders multiple separators', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <ButtonGroupSeparator />
          <Button>Second</Button>
          <ButtonGroupSeparator />
          <Button>Third</Button>
        </ButtonGroup>,
      );
      const separators = component.locator('[data-slot="button-group-separator"]');
      await expect(separators).toHaveCount(2);
    });
  });

  test.describe('ButtonGroupText', () => {
    test('renders text content', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <ButtonGroupText>Label</ButtonGroupText>
          <Button>Action</Button>
        </ButtonGroup>,
      );
      await expect(component).toContainText('Label');
    });

    test('has muted background styling', async ({ mount }) => {
      const component = await mount(<ButtonGroupText>Label</ButtonGroupText>);
      await expect(component).toHaveClass(/bg-muted/);
    });

    test('has border and rounded styling', async ({ mount }) => {
      const component = await mount(<ButtonGroupText>Label</ButtonGroupText>);
      await expect(component).toHaveClass(/border/);
      await expect(component).toHaveClass(/rounded-control/);
    });

    test('has flex layout with gap', async ({ mount }) => {
      const component = await mount(<ButtonGroupText>Label</ButtonGroupText>);
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/items-center/);
      await expect(component).toHaveClass(/gap-2/);
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<ButtonGroupText className="custom-text">Label</ButtonGroupText>);
      await expect(component).toHaveClass(/custom-text/);
    });

    test('has medium font weight', async ({ mount }) => {
      const component = await mount(<ButtonGroupText>Label</ButtonGroupText>);
      await expect(component).toHaveClass(/font-medium/);
    });
  });

  test.describe('composition', () => {
    test('renders button group with separator and text', async ({ mount, page }) => {
      await mount(
        <ButtonGroup>
          <ButtonGroupText>Filter:</ButtonGroupText>
          <Button variant="outline">All</Button>
          <ButtonGroupSeparator />
          <Button variant="outline">Active</Button>
          <ButtonGroupSeparator />
          <Button variant="outline">Archived</Button>
        </ButtonGroup>,
      );

      await expect(page.locator('[data-slot="button-group"]')).toBeVisible();
      await expect(page.getByRole('button')).toHaveCount(3);
      await expect(page.locator('[data-slot="button-group-separator"]')).toHaveCount(2);
    });

    test('renders vertical button group', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup orientation="vertical">
          <Button>Option A</Button>
          <Button>Option B</Button>
          <Button>Option C</Button>
        </ButtonGroup>,
      );

      await expect(component).toHaveAttribute('data-orientation', 'vertical');
      await expect(component).toHaveClass(/flex-col/);
      const buttons = component.getByRole('button');
      await expect(buttons).toHaveCount(3);
    });

    test('buttons within group are clickable', async ({ mount }) => {
      let clicked = '';
      const component = await mount(
        <ButtonGroup>
          <Button onClick={() => (clicked = 'first')}>First</Button>
          <Button onClick={() => (clicked = 'second')}>Second</Button>
        </ButtonGroup>,
      );

      await component.getByRole('button', { name: 'Second' }).click();
      expect(clicked).toBe('second');
    });

    test('renders group with variant buttons', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button variant="default">Primary</Button>
          <Button variant="outline">Secondary</Button>
          <Button variant="destructive">Delete</Button>
        </ButtonGroup>,
      );

      const buttons = component.getByRole('button');
      await expect(buttons).toHaveCount(3);
      await expect(buttons.nth(0)).toHaveText('Primary');
      await expect(buttons.nth(1)).toHaveText('Secondary');
      await expect(buttons.nth(2)).toHaveText('Delete');
    });
  });

  test.describe('accessibility', () => {
    test('group has role="group"', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveRole('group');
    });

    test('supports aria-label on group', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup aria-label="Action buttons">
          <Button>Save</Button>
          <Button>Cancel</Button>
        </ButtonGroup>,
      );
      await expect(component).toHaveAccessibleName('Action buttons');
    });

    test('child buttons are individually accessible', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>Save</Button>
          <Button>Cancel</Button>
        </ButtonGroup>,
      );

      const save = component.getByRole('button', { name: 'Save' });
      const cancel = component.getByRole('button', { name: 'Cancel' });
      await expect(save).toHaveAccessibleName('Save');
      await expect(cancel).toHaveAccessibleName('Cancel');
    });

    test('separator has separator role for assistive technologies', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <ButtonGroupSeparator />
          <Button>Second</Button>
        </ButtonGroup>,
      );
      const separator = component.locator('[data-slot="button-group-separator"]');
      await expect(separator).toHaveRole('none');
    });

    test('buttons in group are focusable', async ({ mount }) => {
      const component = await mount(
        <ButtonGroup>
          <Button>First</Button>
          <Button>Second</Button>
        </ButtonGroup>,
      );

      const first = component.getByRole('button', { name: 'First' });
      await first.focus();
      await expect(first).toBeFocused();
    });
  });
});

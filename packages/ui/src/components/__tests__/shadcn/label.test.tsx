import { test, expect } from '@playwright/experimental-ct-react'
import { Label } from '../../shadcn/label'
import { Input } from '../../shadcn/input'

test.describe('Label', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Label>Email</Label>)
      await expect(component).toBeVisible()
      await expect(component).toHaveText('Email')
      await expect(component).toHaveAttribute('data-slot', 'label')
    })

    test('renders as label element', async ({ mount }) => {
      const component = await mount(<Label>Username</Label>)
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('label')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Label className="custom-label">Label</Label>
      )
      await expect(component).toHaveClass(/custom-label/)
    })
  })

  test.describe('styling', () => {
    test('has correct default styling', async ({ mount }) => {
      const component = await mount(<Label>Label</Label>)
      await expect(component).toHaveClass(/text-sm/)
      await expect(component).toHaveClass(/font-medium/)
    })

    test('has flex display with gap', async ({ mount }) => {
      const component = await mount(<Label>Label</Label>)
      await expect(component).toHaveClass(/flex/)
      await expect(component).toHaveClass(/items-center/)
      await expect(component).toHaveClass(/gap-2/)
    })

    test('prevents text selection', async ({ mount }) => {
      const component = await mount(<Label>Label</Label>)
      await expect(component).toHaveClass(/select-none/)
    })
  })

  test.describe('htmlFor association', () => {
    test('associates with input via htmlFor', async ({ mount }) => {
      const component = await mount(
        <div>
          <Label htmlFor="email-input">Email</Label>
          <Input id="email-input" type="email" />
        </div>
      )

      const label = component.locator('[data-slot="label"]')
      await expect(label).toHaveAttribute('for', 'email-input')
    })

    test('clicking label focuses associated input', async ({ mount }) => {
      const component = await mount(
        <div>
          <Label htmlFor="focus-test">Click me</Label>
          <Input id="focus-test" />
        </div>
      )

      const label = component.locator('[data-slot="label"]')
      const input = component.getByRole('textbox')

      await label.click()
      await expect(input).toBeFocused()
    })
  })

  test.describe('with children', () => {
    test('renders text children', async ({ mount }) => {
      const component = await mount(<Label>Simple text label</Label>)
      await expect(component).toHaveText('Simple text label')
    })

    test('renders with icon and text', async ({ mount }) => {
      const component = await mount(
        <Label>
          <svg data-testid="icon" width="16" height="16" />
          With Icon
        </Label>
      )
      const icon = component.locator('[data-testid="icon"]')
      await expect(icon).toBeVisible()
      await expect(component).toContainText('With Icon')
    })

    test('renders required indicator', async ({ mount }) => {
      const component = await mount(
        <Label>
          Username
          <span className="text-destructive">*</span>
        </Label>
      )
      await expect(component).toContainText('Username')
      await expect(component).toContainText('*')
    })
  })

  test.describe('disabled state styling', () => {
    test('has disabled peer styles', async ({ mount }) => {
      const component = await mount(<Label>Label</Label>)
      await expect(component).toHaveClass(/peer-disabled:cursor-not-allowed/)
      await expect(component).toHaveClass(/peer-disabled:opacity-50/)
    })

    test('has disabled group styles', async ({ mount }) => {
      const component = await mount(<Label>Label</Label>)
      await expect(component).toHaveClass(
        /group-data-\[disabled=true\]:pointer-events-none/
      )
      await expect(component).toHaveClass(
        /group-data-\[disabled=true\]:opacity-50/
      )
    })

    test('appears disabled when peer input is disabled', async ({ mount }) => {
      const component = await mount(
        <div>
          <Input id="disabled-input" disabled className="peer" />
          <Label htmlFor="disabled-input">Disabled Label</Label>
        </div>
      )

      const label = component.locator('[data-slot="label"]')
      await expect(label).toBeVisible()
    })
  })

  test.describe('accessibility', () => {
    test('label provides accessible name to input', async ({ mount }) => {
      const component = await mount(
        <div>
          <Label htmlFor="accessible-input">Accessible Label</Label>
          <Input id="accessible-input" />
        </div>
      )

      const input = component.getByRole('textbox')
      await expect(input).toHaveAccessibleName('Accessible Label')
    })

    test('supports aria-describedby', async ({ mount }) => {
      const component = await mount(
        <div>
          <Label htmlFor="described-input" aria-describedby="label-hint">
            Label
          </Label>
          <span id="label-hint">Additional hint</span>
          <Input id="described-input" />
        </div>
      )

      const label = component.locator('[data-slot="label"]')
      await expect(label).toHaveAttribute('aria-describedby', 'label-hint')
    })
  })

  test.describe('custom attributes', () => {
    test('passes through data attributes', async ({ mount }) => {
      const component = await mount(
        <Label data-testid="test-label" data-required="true">
          Label
        </Label>
      )
      await expect(component).toHaveAttribute('data-testid', 'test-label')
      await expect(component).toHaveAttribute('data-required', 'true')
    })

    test('passes through id attribute', async ({ mount }) => {
      const component = await mount(<Label id="my-label">Label</Label>)
      await expect(component).toHaveAttribute('id', 'my-label')
    })
  })

  test.describe('composition', () => {
    test('multiple labels render independently', async ({ mount }) => {
      const component = await mount(
        <div>
          <Label htmlFor="input1">First Label</Label>
          <Input id="input1" />
          <Label htmlFor="input2">Second Label</Label>
          <Input id="input2" />
        </div>
      )

      const labels = component.locator('[data-slot="label"]')
      await expect(labels).toHaveCount(2)
    })

    test('label with checkbox', async ({ mount }) => {
      const component = await mount(
        <div className="flex items-center gap-2">
          <input type="checkbox" id="terms" />
          <Label htmlFor="terms">Accept terms and conditions</Label>
        </div>
      )

      const label = component.locator('[data-slot="label"]')
      const checkbox = component.getByRole('checkbox')

      await label.click()
      await expect(checkbox).toBeChecked()
    })
  })
})

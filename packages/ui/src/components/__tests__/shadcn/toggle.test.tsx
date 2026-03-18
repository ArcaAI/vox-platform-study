import { test, expect } from '@playwright/experimental-ct-react'
import { Toggle } from '../../shadcn/toggle'

test.describe('Toggle', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Toggle>Bold</Toggle>)
      await expect(component).toBeVisible()
      await expect(component).toHaveText('Bold')
      await expect(component).toHaveAttribute('data-slot', 'toggle')
    })

    test('renders children content', async ({ mount }) => {
      const component = await mount(
        <Toggle>
          <span>Icon</span> Text
        </Toggle>
      )
      await expect(component).toContainText('Text')
    })
  })

  test.describe('variants', () => {
    test('renders default variant with bg-transparent', async ({ mount }) => {
      const component = await mount(<Toggle variant="default">Default</Toggle>)
      await expect(component).toHaveClass(/bg-transparent/)
    })

    test('renders outline variant with border', async ({ mount }) => {
      const component = await mount(<Toggle variant="outline">Outline</Toggle>)
      await expect(component).toHaveClass(/border/)
      await expect(component).toHaveClass(/border-input/)
      await expect(component).toHaveClass(/shadow-xs/)
    })
  })

  test.describe('sizes', () => {
    test('renders default size', async ({ mount }) => {
      const component = await mount(<Toggle size="default">Default</Toggle>)
      await expect(component).toHaveClass(/h-9/)
      await expect(component).toHaveClass(/px-2/)
      await expect(component).toHaveClass(/min-w-9/)
    })

    test('renders sm size', async ({ mount }) => {
      const component = await mount(<Toggle size="sm">Small</Toggle>)
      await expect(component).toHaveClass(/h-8/)
      await expect(component).toHaveClass(/min-w-8/)
    })

    test('renders lg size', async ({ mount }) => {
      const component = await mount(<Toggle size="lg">Large</Toggle>)
      await expect(component).toHaveClass(/h-10/)
      await expect(component).toHaveClass(/min-w-10/)
    })
  })

  test.describe('states', () => {
    test('starts in off state by default', async ({ mount }) => {
      const component = await mount(<Toggle>Toggle</Toggle>)
      await expect(component).toHaveAttribute('data-state', 'off')
    })

    test('starts in on state when defaultPressed', async ({ mount }) => {
      const component = await mount(<Toggle defaultPressed>Toggle</Toggle>)
      await expect(component).toHaveAttribute('data-state', 'on')
    })

    test('toggles from off to on on click', async ({ mount }) => {
      const component = await mount(<Toggle>Toggle</Toggle>)
      await expect(component).toHaveAttribute('data-state', 'off')

      await component.click()
      await expect(component).toHaveAttribute('data-state', 'on')
    })

    test('toggles from on to off on click', async ({ mount }) => {
      const component = await mount(<Toggle defaultPressed>Toggle</Toggle>)
      await expect(component).toHaveAttribute('data-state', 'on')

      await component.click()
      await expect(component).toHaveAttribute('data-state', 'off')
    })

    test('handles disabled state', async ({ mount }) => {
      const component = await mount(<Toggle disabled>Disabled</Toggle>)
      await expect(component).toBeDisabled()
      await expect(component).toHaveClass(/disabled:opacity-50/)
    })

    test('does not toggle when disabled', async ({ mount }) => {
      const component = await mount(<Toggle disabled>Disabled</Toggle>)
      await expect(component).toHaveAttribute('data-state', 'off')

      await component.click({ force: true })
      await expect(component).toHaveAttribute('data-state', 'off')
    })
  })

  test.describe('interactions', () => {
    test('click toggles state', async ({ mount }) => {
      const component = await mount(<Toggle>Click me</Toggle>)

      await component.click()
      await expect(component).toHaveAttribute('data-state', 'on')

      await component.click()
      await expect(component).toHaveAttribute('data-state', 'off')
    })

    test('Enter key toggles state', async ({ mount }) => {
      const component = await mount(<Toggle>Press Enter</Toggle>)
      await component.focus()

      await component.press('Enter')
      await expect(component).toHaveAttribute('data-state', 'on')

      await component.press('Enter')
      await expect(component).toHaveAttribute('data-state', 'off')
    })

    test('Space key toggles state', async ({ mount }) => {
      const component = await mount(<Toggle>Press Space</Toggle>)
      await component.focus()

      await component.press(' ')
      await expect(component).toHaveAttribute('data-state', 'on')

      await component.press(' ')
      await expect(component).toHaveAttribute('data-state', 'off')
    })
  })

  test.describe('styling', () => {
    test('has inline-flex and items-center', async ({ mount }) => {
      const component = await mount(<Toggle>Styled</Toggle>)
      await expect(component).toHaveClass(/inline-flex/)
      await expect(component).toHaveClass(/items-center/)
    })

    test('has rounded-md', async ({ mount }) => {
      const component = await mount(<Toggle>Styled</Toggle>)
      await expect(component).toHaveClass(/rounded-md/)
    })

    test('has text-sm and font-medium', async ({ mount }) => {
      const component = await mount(<Toggle>Styled</Toggle>)
      await expect(component).toHaveClass(/text-sm/)
      await expect(component).toHaveClass(/font-medium/)
    })

    test('on state has accent styling class', async ({ mount }) => {
      const component = await mount(<Toggle>Styled</Toggle>)
      await expect(component).toHaveClass(/data-\[state=on\]:bg-accent/)
    })
  })

  test.describe('accessibility', () => {
    test('has button role', async ({ mount }) => {
      const component = await mount(<Toggle>Accessible</Toggle>)
      await expect(component).toHaveRole('button')
    })

    test('has aria-pressed false when off', async ({ mount }) => {
      const component = await mount(<Toggle>Toggle</Toggle>)
      await expect(component).toHaveAttribute('aria-pressed', 'false')
    })

    test('has aria-pressed true when on', async ({ mount }) => {
      const component = await mount(<Toggle defaultPressed>Toggle</Toggle>)
      await expect(component).toHaveAttribute('aria-pressed', 'true')
    })

    test('aria-pressed updates on toggle', async ({ mount }) => {
      const component = await mount(<Toggle>Toggle</Toggle>)
      await expect(component).toHaveAttribute('aria-pressed', 'false')

      await component.click()
      await expect(component).toHaveAttribute('aria-pressed', 'true')
    })

    test('disabled state is communicated to assistive technologies', async ({
      mount,
    }) => {
      const component = await mount(<Toggle disabled>Disabled</Toggle>)
      await expect(component).toBeDisabled()
    })

    test('is focusable when enabled', async ({ mount }) => {
      const component = await mount(<Toggle>Focusable</Toggle>)
      await component.focus()
      await expect(component).toBeFocused()
    })

    test('supports aria-label', async ({ mount }) => {
      const component = await mount(
        <Toggle aria-label="Toggle bold">B</Toggle>
      )
      await expect(component).toHaveAccessibleName('Toggle bold')
    })
  })

  test.describe('custom className', () => {
    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Toggle className="custom-toggle">Toggle</Toggle>
      )
      await expect(component).toHaveClass(/custom-toggle/)
    })

    test('merges custom className with default classes', async ({ mount }) => {
      const component = await mount(
        <Toggle className="my-class">Toggle</Toggle>
      )
      await expect(component).toHaveClass(/my-class/)
      await expect(component).toHaveClass(/inline-flex/)
    })
  })
})

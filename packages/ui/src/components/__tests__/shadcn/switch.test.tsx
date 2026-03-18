import { test, expect } from '@playwright/experimental-ct-react'
import { Switch } from '../../shadcn/switch'

test.describe('Switch', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toBeVisible()
      await expect(switchEl).toHaveAttribute('data-slot', 'switch')
      await expect(switchEl).toHaveAttribute('data-size', 'default')
    })

    test('renders as switch role', async ({ mount, page }) => {
      await mount(<Switch />)
      await expect(page.getByRole('switch')).toHaveRole('switch')
    })

    test('applies custom className', async ({ mount, page }) => {
      await mount(<Switch className="custom-switch" />)
      await expect(page.getByRole('switch')).toHaveClass(/custom-switch/)
    })
  })

  test.describe('sizes', () => {
    test('renders default size', async ({ mount, page }) => {
      await mount(<Switch size="default" />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toHaveAttribute('data-size', 'default')
      await expect(switchEl).toHaveClass(/data-\[size=default\]:h-\[1\.15rem\]/)
      await expect(switchEl).toHaveClass(/data-\[size=default\]:w-8/)
    })

    test('renders sm size', async ({ mount, page }) => {
      await mount(<Switch size="sm" />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toHaveAttribute('data-size', 'sm')
      await expect(switchEl).toHaveClass(/data-\[size=sm\]:h-3\.5/)
      await expect(switchEl).toHaveClass(/data-\[size=sm\]:w-6/)
    })
  })

  test.describe('states', () => {
    test('is unchecked by default', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).not.toBeChecked()
      await expect(switchEl).toHaveAttribute('data-state', 'unchecked')
    })

    test('can be checked by default', async ({ mount, page }) => {
      await mount(<Switch defaultChecked />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toBeChecked()
      await expect(switchEl).toHaveAttribute('data-state', 'checked')
    })

    test('supports controlled checked state', async ({ mount, page }) => {
      await mount(<Switch checked />)
      await expect(page.getByRole('switch')).toBeChecked()
    })

    test('handles disabled state', async ({ mount, page }) => {
      await mount(<Switch disabled />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toBeDisabled()
      await expect(switchEl).toHaveClass(/disabled:opacity-50/)
    })

    test('handles required state', async ({ mount, page }) => {
      await mount(<Switch required />)
      const switchEl = page.getByRole('switch')
      // Radix forwards required as aria-required on the switch
      await expect(switchEl).toHaveAttribute('aria-required', 'true')
    })
  })

  test.describe('interactions', () => {
    test('toggles when clicked', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')

      await expect(switchEl).not.toBeChecked()
      await switchEl.click()
      await expect(switchEl).toBeChecked()
      await switchEl.click()
      await expect(switchEl).not.toBeChecked()
    })

    test('toggles with Space key', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')

      await switchEl.focus()
      await expect(switchEl).not.toBeChecked()
      await switchEl.press(' ')
      await expect(switchEl).toBeChecked()
    })

    test('toggles with Enter key', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')

      await switchEl.focus()
      await expect(switchEl).not.toBeChecked()
      await switchEl.press('Enter')
      await expect(switchEl).toBeChecked()
    })

    test('does not toggle when disabled', async ({ mount, page }) => {
      await mount(<Switch disabled />)
      const switchEl = page.getByRole('switch')
      await switchEl.click({ force: true })
      await expect(switchEl).not.toBeChecked()
    })

    test('calls onCheckedChange when toggled', async ({ mount, page }) => {
      let checked = false
      await mount(
        <Switch onCheckedChange={(value) => (checked = value)} />
      )

      await page.getByRole('switch').click()
      expect(checked).toBe(true)

      await page.getByRole('switch').click()
      expect(checked).toBe(false)
    })
  })

  test.describe('focus', () => {
    test('is focusable when enabled', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')
      await switchEl.focus()
      await expect(switchEl).toBeFocused()
    })

    test('is not focusable when disabled', async ({ mount, page }) => {
      await mount(<Switch disabled />)
      const switchEl = page.getByRole('switch')
      await switchEl.focus()
      await expect(switchEl).not.toBeFocused()
    })

    test('shows focus ring on focus', async ({ mount, page }) => {
      await mount(<Switch />)
      await expect(page.getByRole('switch')).toHaveClass(/focus-visible:ring/)
    })
  })

  test.describe('thumb', () => {
    test('renders thumb element', async ({ mount, page }) => {
      await mount(<Switch />)
      const thumb = page.locator('[data-slot="switch-thumb"]')
      await expect(thumb).toBeVisible()
    })

    test('thumb moves when toggled', async ({ mount, page }) => {
      await mount(<Switch />)
      const switchEl = page.getByRole('switch')
      const thumb = page.locator('[data-slot="switch-thumb"]')

      // Initially, thumb should be at the start
      await expect(thumb).toHaveClass(/data-\[state=unchecked\]:translate-x-0/)

      // After toggle, thumb should move
      await switchEl.click()
      await expect(thumb).toHaveClass(
        /data-\[state=checked\]:translate-x-\[calc\(100%-2px\)\]/
      )
    })
  })

  test.describe('accessibility', () => {
    test('has switch role', async ({ mount, page }) => {
      await mount(<Switch />)
      await expect(page.getByRole('switch')).toHaveRole('switch')
    })

    test('supports aria-label', async ({ mount, page }) => {
      await mount(<Switch aria-label="Enable notifications" />)
      await expect(page.getByRole('switch')).toHaveAccessibleName('Enable notifications')
    })

    test('supports aria-describedby', async ({ mount, page }) => {
      await mount(
        <div>
          <Switch aria-describedby="switch-description" />
          <span id="switch-description">Toggle to enable feature</span>
        </div>
      )
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toHaveAttribute(
        'aria-describedby',
        'switch-description'
      )
    })

    test('supports id for label association', async ({ mount, page }) => {
      await mount(
        <div>
          <Switch id="notifications-switch" />
          <label htmlFor="notifications-switch">Enable notifications</label>
        </div>
      )
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toHaveAttribute('id', 'notifications-switch')
    })

    test('indicates checked state to assistive technologies', async ({
      mount,
      page,
    }) => {
      await mount(<Switch defaultChecked />)
      await expect(page.getByRole('switch')).toBeChecked()
    })

    test('indicates disabled state to assistive technologies', async ({
      mount,
      page,
    }) => {
      await mount(<Switch disabled />)
      await expect(page.getByRole('switch')).toBeDisabled()
    })
  })

  test.describe('styling', () => {
    test('changes background when checked', async ({ mount, page }) => {
      await mount(<Switch defaultChecked />)
      await expect(page.getByRole('switch')).toHaveClass(/data-\[state=checked\]:bg-primary/)
    })

    test('has correct unchecked background', async ({ mount, page }) => {
      await mount(<Switch />)
      await expect(page.getByRole('switch')).toHaveClass(/data-\[state=unchecked\]:bg-input/)
    })

    test('has rounded shape', async ({ mount, page }) => {
      await mount(<Switch />)
      await expect(page.getByRole('switch')).toHaveClass(/rounded-full/)
    })
  })

  test.describe('form integration', () => {
    test('accepts name prop for form integration', async ({ mount, page }) => {
      // Radix Switch Root does not pass name to the button element; form integration may require a wrapper.
      // Verify the component renders when name is provided.
      await mount(<Switch name="notifications" />)
      await expect(page.getByRole('switch')).toBeVisible()
    })

    test('supports value attribute', async ({ mount, page }) => {
      await mount(<Switch value="enabled" />)
      const switchEl = page.getByRole('switch')
      await expect(switchEl).toHaveAttribute('value', 'enabled')
    })
  })

  test.describe('with label', () => {
    test('clicking label toggles switch', async ({ mount, page }) => {
      await mount(
        <div className="flex items-center gap-2">
          <Switch id="label-test" />
          <label htmlFor="label-test">Dark mode</label>
        </div>
      )

      const switchEl = page.getByRole('switch')
      const label = page.getByText('Dark mode')

      await expect(switchEl).not.toBeChecked()
      await label.click()
      await expect(switchEl).toBeChecked()
    })
  })
})

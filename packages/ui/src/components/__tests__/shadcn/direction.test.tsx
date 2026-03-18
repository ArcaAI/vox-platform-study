import { test, expect } from '@playwright/experimental-ct-react'
import { DirectionProvider } from '../../shadcn/direction'

test.describe('DirectionProvider', () => {
  test.describe('rendering', () => {
    test('renders children in LTR by default', async ({ mount, page }) => {
      await mount(
        <DirectionProvider>
          <div data-testid="child">Hello</div>
        </DirectionProvider>
      )
      const child = page.getByTestId('child')
      await expect(child).toBeVisible()
      await expect(child).toHaveText('Hello')
    })

    test('renders children in RTL mode', async ({ mount, page }) => {
      await mount(
        <DirectionProvider direction="rtl">
          <div data-testid="rtl-child" dir="rtl">
            RTL Content
          </div>
        </DirectionProvider>
      )
      const child = page.getByTestId('rtl-child')
      await expect(child).toBeVisible()
      await expect(child).toHaveAttribute('dir', 'rtl')
    })

    test('wraps content with Radix DirectionProvider', async ({ mount, page }) => {
      await mount(
        <DirectionProvider direction="ltr">
          <span>Wrapped</span>
        </DirectionProvider>
      )
      await expect(page.locator('span')).toHaveText('Wrapped')
    })
  })
})

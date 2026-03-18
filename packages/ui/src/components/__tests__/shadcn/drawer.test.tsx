import { test, expect } from '@playwright/experimental-ct-react'
import { ControlledDrawer } from '../fixtures/shadcn/drawer-fixtures'

test.describe('Drawer', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<ControlledDrawer />)
      const trigger = page.getByRole('button', { name: 'Open Drawer' })
      await expect(trigger).toBeVisible()
    })

    test('drawer content is hidden by default', async ({ mount, page }) => {
      await mount(<ControlledDrawer />)
      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).not.toBeVisible()
    })

    test('drawer content is visible when defaultOpen is true', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).toBeVisible()
    })
  })

  test.describe('opening and closing', () => {
    test('opens drawer when trigger is clicked', async ({ mount, page }) => {
      await mount(<ControlledDrawer />)
      const trigger = page.getByRole('button', { name: 'Open Drawer' })
      await trigger.click()

      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).toBeVisible()
    })

    test('closes drawer when close button is clicked', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDrawer defaultOpen />)

      const closeButton = page.getByRole('button', { name: 'Close' })
      await closeButton.click()

      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).not.toBeVisible()
    })

    test('closes drawer when Escape key is pressed', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDrawer defaultOpen />)

      await page.keyboard.press('Escape')

      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).not.toBeVisible()
    })
  })

  test.describe('content structure', () => {
    test('renders drawer title', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const title = page.locator('[data-slot="drawer-title"]')
      await expect(title).toBeVisible()
      await expect(title).toHaveText('Drawer Title')
    })

    test('renders drawer description', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const description = page.locator('[data-slot="drawer-description"]')
      await expect(description).toBeVisible()
      await expect(description).toHaveText('Drawer description text')
    })

    test('renders drawer header', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const header = page.locator('[data-slot="drawer-header"]')
      await expect(header).toBeVisible()
    })

    test('renders drawer footer', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const footer = page.locator('[data-slot="drawer-footer"]')
      await expect(footer).toBeVisible()
    })

    test('renders custom content', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).toContainText('Drawer content goes here')
    })
  })

  test.describe('overlay', () => {
    test('renders overlay when drawer is open', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const overlay = page.locator('[data-slot="drawer-overlay"]')
      await expect(overlay).toBeVisible()
    })

    test('overlay has correct styling', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const overlay = page.locator('[data-slot="drawer-overlay"]')
      await expect(overlay).toHaveClass(/fixed/)
      await expect(overlay).toHaveClass(/inset-0/)
    })
  })

  test.describe('styling', () => {
    test('drawer content has fixed positioning', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).toHaveClass(/fixed/)
    })

    test('drawer header has flex layout', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const header = page.locator('[data-slot="drawer-header"]')
      await expect(header).toHaveClass(/flex/)
      await expect(header).toHaveClass(/flex-col/)
    })

    test('drawer footer has flex layout', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const footer = page.locator('[data-slot="drawer-footer"]')
      await expect(footer).toHaveClass(/flex/)
      await expect(footer).toHaveClass(/flex-col/)
    })

    test('applies custom className to drawer content', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const content = page.locator('[data-slot="drawer-content"]')
      await expect(content).toHaveClass(/bg-background/)
    })
  })

  test.describe('accessibility', () => {
    test('drawer has dialog role when open', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
    })

    test('drawer is labelled by title', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toHaveAccessibleName('Drawer Title')
    })

    test('drawer has accessible description', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toHaveAccessibleDescription(
        'Drawer description text'
      )
    })

    test('trigger has correct data-slot', async ({ mount, page }) => {
      await mount(<ControlledDrawer />)
      const trigger = page.getByRole('button', { name: 'Open Drawer' })
      await expect(trigger).toHaveAttribute('data-slot', 'drawer-trigger')
    })
  })

  test.describe('drag handle', () => {
    test('renders drag handle inside content', async ({ mount, page }) => {
      await mount(<ControlledDrawer defaultOpen />)
      const content = page.locator('[data-slot="drawer-content"]')
      const handle = content.locator('.bg-muted.rounded-full')
      await expect(handle).toBeAttached()
    })
  })
})

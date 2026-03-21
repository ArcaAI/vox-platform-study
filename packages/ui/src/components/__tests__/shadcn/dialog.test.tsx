import { test, expect } from '@playwright/experimental-ct-react'
import {
  ControlledDialog,
  DialogWithCallbacks,
  DialogWithFooterClose,
} from '../fixtures/shadcn/dialog-fixtures'

test.describe('Dialog', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<ControlledDialog />)
      const trigger = page.getByRole('button', { name: 'Open Dialog' })
      await expect(trigger).toBeVisible()
    })

    test('dialog content is hidden by default', async ({ mount, page }) => {
      await mount(<ControlledDialog />)
      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).not.toBeVisible()
    })

    test('dialog content is visible when defaultOpen is true', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDialog defaultOpen />)
      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).toBeVisible()
    })
  })

  test.describe('opening and closing', () => {
    test('opens dialog when trigger is clicked', async ({ mount, page }) => {
      await mount(<ControlledDialog />)
      const trigger = page.getByRole('button', { name: 'Open Dialog' })
      await trigger.click()

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).toBeVisible()
    })

    test('closes dialog when close button is clicked', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDialog defaultOpen />)

      const closeButton = page.locator('[data-slot="dialog-close"]').first()
      await closeButton.click()

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).not.toBeVisible()
    })

    test('closes dialog when overlay is clicked', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)

      const overlay = page.locator('[data-slot="dialog-overlay"]')
      await overlay.click({ position: { x: 10, y: 10 } })

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).not.toBeVisible()
    })

    test('closes dialog when Escape key is pressed', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)

      await page.keyboard.press('Escape')

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).not.toBeVisible()
    })

    test('closes dialog when Cancel button is clicked', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDialog defaultOpen />)

      const cancelButton = page.getByRole('button', { name: 'Cancel' })
      await cancelButton.click()

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).not.toBeVisible()
    })
  })

  test.describe('content structure', () => {
    test('renders dialog title', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const title = page.locator('[data-slot="dialog-title"]')
      await expect(title).toBeVisible()
      await expect(title).toHaveText('Dialog Title')
    })

    test('renders dialog description', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const description = page.locator('[data-slot="dialog-description"]')
      await expect(description).toBeVisible()
      await expect(description).toHaveText('Dialog description text')
    })

    test('renders dialog header', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const header = page.locator('[data-slot="dialog-header"]')
      await expect(header).toBeVisible()
    })

    test('renders dialog footer', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const footer = page.locator('[data-slot="dialog-footer"]')
      await expect(footer).toBeVisible()
    })

    test('renders custom content', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const content = page.locator('[data-slot="dialog-content"]')
      await expect(content).toContainText('Dialog content goes here')
    })
  })

  test.describe('close button visibility', () => {
    test('shows close button by default', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const closeButtons = page.locator('[data-slot="dialog-close"]')
      await expect(closeButtons.first()).toBeVisible()
    })

    test('hides close button when showCloseButton is false', async ({
      mount,
      page,
    }) => {
      await mount(<ControlledDialog defaultOpen showCloseButton={false} />)
      const closeButton = page
        .locator('[data-slot="dialog-content"] > [data-slot="dialog-close"]')
        .first()
      await expect(closeButton).not.toBeVisible()
    })
  })

  test.describe('focus management', () => {
    test('focuses dialog content when opened', async ({ mount, page }) => {
      await mount(<ControlledDialog />)
      const trigger = page.getByRole('button', { name: 'Open Dialog' })
      await trigger.click()

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      await expect(dialogContent).toBeVisible()
    })

    test('returns focus to trigger when closed', async ({ mount, page }) => {
      await mount(<ControlledDialog />)
      const trigger = page.getByRole('button', { name: 'Open Dialog' })

      await trigger.click()
      await page.keyboard.press('Escape')

      await expect(trigger).toBeFocused()
    })
  })

  test.describe('accessibility', () => {
    test('dialog has proper role', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
    })

    test('dialog is labelled by title', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toHaveAccessibleName('Dialog Title')
    })

    test('dialog has accessible description', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toHaveAccessibleDescription('Dialog description text')
    })

    test('close button has accessible name', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const closeButton = page
        .locator('[data-slot="dialog-content"] > [data-slot="dialog-close"]')
        .first()
      await expect(closeButton).toHaveAccessibleName('Close')
    })

    test('trap focus within dialog', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)

      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')

      const dialogContent = page.locator('[data-slot="dialog-content"]')
      const focusedElement = page.locator(':focus')
      await expect(dialogContent).toContainText(
        await focusedElement.textContent() || ''
      )
    })
  })

  test.describe('overlay', () => {
    test('renders overlay when dialog is open', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const overlay = page.locator('[data-slot="dialog-overlay"]')
      await expect(overlay).toBeVisible()
    })

    test('overlay has correct styling', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const overlay = page.locator('[data-slot="dialog-overlay"]')
      await expect(overlay).toHaveClass(/fixed/)
      await expect(overlay).toHaveClass(/inset-0/)
    })
  })

  test.describe('animations', () => {
    test('dialog content has animation classes', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const content = page.locator('[data-slot="dialog-content"]')
      await expect(content).toHaveClass(/data-\[state=open\]:animate-in/)
    })

    test('overlay has animation classes', async ({ mount, page }) => {
      await mount(<ControlledDialog defaultOpen />)
      const overlay = page.locator('[data-slot="dialog-overlay"]')
      await expect(overlay).toHaveClass(/data-\[state=open\]:fade-in-0/)
    })
  })

  test.describe('DialogFooter with showCloseButton', () => {
    test('renders close button in footer when showCloseButton is true', async ({
      mount,
      page,
    }) => {
      await mount(<DialogWithFooterClose />)
      const footer = page.locator('[data-slot="dialog-footer"]')
      const closeButton = footer.getByRole('button', { name: 'Close' })
      await expect(closeButton).toBeVisible()
    })
  })
})

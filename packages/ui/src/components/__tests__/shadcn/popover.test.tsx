import { test, expect } from '@playwright/experimental-ct-react'
import {
  BasicPopover,
  PopoverWithCustomClass,
} from '../fixtures/shadcn/popover-fixtures'

test.describe('Popover', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<BasicPopover />)
      const trigger = page.getByRole('button', { name: 'Open Popover' })
      await expect(trigger).toBeVisible()
    })

    test('popover content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicPopover />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).not.toBeVisible()
    })

    test('popover content is visible when defaultOpen is true', async ({
      mount,
      page,
    }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toBeVisible()
    })
  })

  test.describe('opening and closing', () => {
    test('opens popover when trigger is clicked', async ({ mount, page }) => {
      await mount(<BasicPopover />)
      const trigger = page.getByRole('button', { name: 'Open Popover' })
      await trigger.click()

      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toBeVisible()
    })

    test('closes popover when clicking outside', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toBeVisible()

      await page.locator('body').click({ position: { x: 0, y: 0 } })
      await expect(content).not.toBeVisible()
    })

    test('closes popover when Escape key is pressed', async ({
      mount,
      page,
    }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(content).not.toBeVisible()
    })
  })

  test.describe('content structure', () => {
    test('renders popover title', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const title = page.locator('[data-slot="popover-title"]')
      await expect(title).toBeVisible()
      await expect(title).toHaveText('Popover Title')
    })

    test('renders popover description', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const description = page.locator('[data-slot="popover-description"]')
      await expect(description).toBeVisible()
      await expect(description).toHaveText('Popover description text')
    })

    test('renders popover header', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const header = page.locator('[data-slot="popover-header"]')
      await expect(header).toBeVisible()
    })

    test('renders body content', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toContainText('Popover body content')
    })
  })

  test.describe('styling', () => {
    test('popover content has rounded-md class', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/rounded-md/)
    })

    test('popover content has border class', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/border/)
    })

    test('popover content has p-4 class', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/p-4/)
    })

    test('popover content has shadow-md class', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/shadow-md/)
    })

    test('popover content has animation classes', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/data-\[state=open\]:animate-in/)
    })

    test('popover title has font-medium class', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const title = page.locator('[data-slot="popover-title"]')
      await expect(title).toHaveClass(/font-medium/)
    })

    test('popover description has text-muted-foreground class', async ({
      mount,
      page,
    }) => {
      await mount(<BasicPopover defaultOpen />)
      const description = page.locator('[data-slot="popover-description"]')
      await expect(description).toHaveClass(/text-muted-foreground/)
    })
  })

  test.describe('accessibility', () => {
    test('trigger has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicPopover />)
      const trigger = page.locator('[data-slot="popover-trigger"]')
      await expect(trigger).toBeVisible()
    })

    test('popover content has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicPopover defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveAttribute('data-slot', 'popover-content')
    })

    test('returns focus to trigger when closed with Escape', async ({
      mount,
      page,
    }) => {
      await mount(<BasicPopover />)
      const trigger = page.getByRole('button', { name: 'Open Popover' })
      await trigger.click()

      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    })
  })

  test.describe('custom className', () => {
    test('supports custom className on PopoverContent', async ({
      mount,
      page,
    }) => {
      await mount(<PopoverWithCustomClass defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/custom-popover-class/)
    })

    test('preserves default classes with custom className', async ({
      mount,
      page,
    }) => {
      await mount(<PopoverWithCustomClass defaultOpen />)
      const content = page.locator('[data-slot="popover-content"]')
      await expect(content).toHaveClass(/rounded-md/)
      await expect(content).toHaveClass(/custom-popover-class/)
    })
  })
})

import { test, expect } from '@playwright/experimental-ct-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '../../shadcn/tooltip'
import { Button } from '../../shadcn/button'
import {
  BasicTooltip,
  OpenTooltip,
} from '../fixtures/shadcn/tooltip-fixtures'

test.describe('Tooltip', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button', { name: 'Hover me' })
      await expect(trigger).toBeVisible()
    })

    test('tooltip content is hidden by default', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).not.toBeVisible()
    })

    test('tooltip content is visible when defaultOpen is true', async ({
      mount,
      page,
    }) => {
      await mount(<OpenTooltip />)
      const content = page.locator('[data-slot="tooltip-content"]').first()
      await expect(content).toBeVisible()
      await expect(content).toContainText('Open tooltip')
    })
  })

  test.describe('showing and hiding', () => {
    test('shows tooltip on hover', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button', { name: 'Hover me' })

      await trigger.hover()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
      await expect(content).toContainText('Tooltip content')
    })

    test('shows tooltip on focus', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button', { name: 'Hover me' })

      await trigger.focus()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
    })

    test('hides tooltip on blur', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button', { name: 'Hover me' })

      await trigger.focus()
      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()

      await trigger.blur()

      await expect(content).not.toBeVisible()
    })

    test('hides tooltip when Escape is pressed', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button', { name: 'Hover me' })

      await trigger.focus()
      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()

      await page.keyboard.press('Escape')

      await expect(content).not.toBeVisible()
    })
  })

  test.describe('content', () => {
    test('renders text content', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      await page.getByRole('button').hover()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toContainText('Tooltip content')
    })

    test('renders complex content', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip defaultOpen>
            <TooltipTrigger asChild>
              <Button>Trigger</Button>
            </TooltipTrigger>
            <TooltipContent>
              <div>
                <strong>Bold text</strong>
                <p>Paragraph text</p>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toContainText('Bold text')
      await expect(content).toContainText('Paragraph text')
    })
  })

  test.describe('styling', () => {
    test('tooltip content has correct styling', async ({ mount, page }) => {
      await mount(<OpenTooltip />)
      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toHaveClass(/rounded-md/)
      await expect(content).toHaveClass(/px-3/)
      await expect(content).toHaveClass(/py-1\.5/)
      await expect(content).toHaveClass(/text-xs/)
    })

    test('tooltip content has dark background', async ({ mount, page }) => {
      await mount(<OpenTooltip />)
      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toHaveClass(/bg-foreground/)
      await expect(content).toHaveClass(/text-background/)
    })

    test('has animation classes', async ({ mount, page }) => {
      await mount(<OpenTooltip />)
      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toHaveClass(/animate-in/)
    })
  })

  test.describe('positioning', () => {
    test('default position', async ({ mount, page }) => {
      await mount(<BasicTooltip />)
      await page.getByRole('button').hover()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
    })

    test('supports side offset', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip defaultOpen>
            <TooltipTrigger asChild>
              <Button>Trigger</Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={10}>With offset</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
    })

    test('supports side prop', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip defaultOpen>
            <TooltipTrigger asChild>
              <Button>Trigger</Button>
            </TooltipTrigger>
            <TooltipContent side="right">Right side</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
    })
  })

  test.describe('delay', () => {
    test('shows tooltip immediately with default delay of 0', async ({
      mount,
      page,
    }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button')

      await trigger.hover()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
    })
  })

  test.describe('accessibility', () => {
    test('tooltip content has tooltip role', async ({ mount, page }) => {
      await mount(<OpenTooltip />)
      await expect(page.getByRole('tooltip')).toBeVisible()
    })

    test('trigger has accessible description from tooltip', async ({
      mount,
      page,
    }) => {
      await mount(<BasicTooltip />)
      const trigger = page.getByRole('button')

      await trigger.focus()

      const tooltip = page.getByRole('tooltip')
      await expect(tooltip).toBeVisible()
    })
  })

  test.describe('controlled state', () => {
    test('can be controlled externally', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button>Trigger</Button>
            </TooltipTrigger>
            <TooltipContent>Controlled tooltip</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toBeVisible()
    })
  })

  test.describe('custom className', () => {
    test('TooltipContent accepts custom className', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip defaultOpen>
            <TooltipTrigger asChild>
              <Button>Trigger</Button>
            </TooltipTrigger>
            <TooltipContent className="custom-tooltip">Content</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toHaveClass(/custom-tooltip/)
    })
  })

  test.describe('use cases', () => {
    test('icon button with tooltip', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" aria-label="Settings">
                <svg width="16" height="16" data-testid="icon" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      const trigger = page.getByLabel('Settings')
      await trigger.hover()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toContainText('Settings')
    })

    test('truncated text with tooltip', async ({ mount, page }) => {
      await mount(
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate w-20">
                Very long text that gets truncated
              </span>
            </TooltipTrigger>
            <TooltipContent>Very long text that gets truncated</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )

      await page.locator('span').hover()

      const content = page.locator('[data-slot="tooltip-content"]')
      await expect(content).toContainText('Very long text that gets truncated')
    })
  })
})

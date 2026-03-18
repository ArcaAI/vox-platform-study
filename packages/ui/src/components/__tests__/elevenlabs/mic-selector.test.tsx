import { test, expect } from '@playwright/experimental-ct-react'
import { MicSelector } from '../../elevenlabs/mic-selector'

test.describe('MicSelector', () => {
  test.describe('rendering', () => {
    test('renders mic selector button', async ({ mount, page }) => {
      await mount(<MicSelector />)
      const trigger = page.locator('button').first()
      await expect(trigger).toBeVisible()
    })

    test('applies custom className', async ({ mount, page }) => {
      await mount(<MicSelector className="custom-mic" />)
      const trigger = page.locator('button').first()
      await expect(trigger).toHaveClass(/custom-mic/)
    })
  })

  test.describe('disabled state', () => {
    test('renders disabled button', async ({ mount, page }) => {
      await mount(<MicSelector disabled />)
      const trigger = page.locator('button').first()
      await expect(trigger).toBeDisabled()
    })
  })

  test.describe('button content', () => {
    test('shows mic icon', async ({ mount, page }) => {
      await mount(<MicSelector />)
      const trigger = page.locator('button').first()
      const svg = trigger.locator('svg').first()
      await expect(svg).toBeVisible()
    })

    test('shows chevron icon', async ({ mount, page }) => {
      await mount(<MicSelector />)
      const trigger = page.locator('button').first()
      const svgs = trigger.locator('svg')
      const count = await svgs.count()
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })

  test.describe('styling', () => {
    test('has ghost variant by default', async ({ mount, page }) => {
      await mount(<MicSelector />)
      const trigger = page.locator('button').first()
      await expect(trigger).toHaveAttribute('data-variant', 'ghost')
    })

    test('has small size', async ({ mount, page }) => {
      await mount(<MicSelector />)
      const trigger = page.locator('button').first()
      await expect(trigger).toHaveAttribute('data-size', 'sm')
    })
  })
})

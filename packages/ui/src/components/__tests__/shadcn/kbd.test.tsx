import { test, expect } from '@playwright/experimental-ct-react'
import { Kbd, KbdGroup } from '../../shadcn/kbd'

test.describe('Kbd', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Kbd>⌘</Kbd>)
      await expect(component).toBeVisible()
      await expect(component).toHaveText('⌘')
      await expect(component).toHaveAttribute('data-slot', 'kbd')
    })

    test('renders as a kbd element', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('kbd')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Kbd className="custom-kbd">K</Kbd>)
      await expect(component).toHaveClass(/custom-kbd/)
    })
  })

  test.describe('styling', () => {
    test('has bg-muted class', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      await expect(component).toHaveClass(/bg-muted/)
    })

    test('has text-xs class', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      await expect(component).toHaveClass(/text-xs/)
    })

    test('has font-medium class', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      await expect(component).toHaveClass(/font-medium/)
    })

    test('has rounded-sm class', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      await expect(component).toHaveClass(/rounded-sm/)
    })

    test('has inline-flex class', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      await expect(component).toHaveClass(/inline-flex/)
    })

    test('has items-center and justify-center', async ({ mount }) => {
      const component = await mount(<Kbd>K</Kbd>)
      await expect(component).toHaveClass(/items-center/)
      await expect(component).toHaveClass(/justify-center/)
    })
  })

  test.describe('KbdGroup', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<KbdGroup>Group</KbdGroup>)
      await expect(component).toBeVisible()
      await expect(component).toHaveAttribute('data-slot', 'kbd-group')
    })

    test('renders as a kbd element', async ({ mount }) => {
      const component = await mount(<KbdGroup>Group</KbdGroup>)
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('kbd')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <KbdGroup className="custom-group">Group</KbdGroup>
      )
      await expect(component).toHaveClass(/custom-group/)
    })

    test('has inline-flex and items-center', async ({ mount }) => {
      const component = await mount(<KbdGroup>Group</KbdGroup>)
      await expect(component).toHaveClass(/inline-flex/)
      await expect(component).toHaveClass(/items-center/)
    })
  })

  test.describe('composition', () => {
    test('KbdGroup with multiple Kbd children', async ({ mount }) => {
      const component = await mount(
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      )

      const kbds = component.locator('[data-slot="kbd"]')
      await expect(kbds).toHaveCount(2)
      await expect(kbds.first()).toHaveText('⌘')
      await expect(kbds.last()).toHaveText('K')
    })

    test('KbdGroup with separator text', async ({ mount }) => {
      const component = await mount(
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <span>+</span>
          <Kbd>C</Kbd>
        </KbdGroup>
      )

      const kbds = component.locator('[data-slot="kbd"]')
      await expect(kbds).toHaveCount(2)
      await expect(component).toContainText('+')
    })

    test('multiple KbdGroups render independently', async ({ mount }) => {
      const component = await mount(
        <div>
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>S</Kbd>
          </KbdGroup>
        </div>
      )

      const groups = component.locator('[data-slot="kbd-group"]')
      await expect(groups).toHaveCount(2)
    })
  })

  test.describe('accessibility', () => {
    test('uses semantic kbd element for keyboard shortcuts', async ({
      mount,
    }) => {
      const component = await mount(<Kbd>Enter</Kbd>)
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('kbd')
    })

    test('KbdGroup uses semantic kbd element', async ({ mount }) => {
      const component = await mount(
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      )
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('kbd')
    })

    test('supports aria-label', async ({ mount }) => {
      const component = await mount(
        <Kbd aria-label="Command key">⌘</Kbd>
      )
      await expect(component).toHaveAttribute('aria-label', 'Command key')
    })
  })
})

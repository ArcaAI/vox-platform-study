import { test, expect } from '@playwright/experimental-ct-react'
import { Progress } from '../../shadcn/progress'

test.describe('Progress', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Progress />)
      await expect(component).toBeVisible()
      await expect(component).toHaveAttribute('data-slot', 'progress')
    })

    test('renders as a progressbar element', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveRole('progressbar')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<Progress className="custom-progress" />)
      await expect(component).toHaveClass(/custom-progress/)
    })
  })

  test.describe('value', () => {
    test('renders with value=0', async ({ mount }) => {
      const component = await mount(<Progress value={0} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute(
        'style',
        'transform: translateX(-100%);'
      )
    })

    test('renders with value=50', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute(
        'style',
        'transform: translateX(-50%);'
      )
    })

    test('renders with value=100', async ({ mount }) => {
      const component = await mount(<Progress value={100} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute(
        'style',
        'transform: translateX(0%);'
      )
    })

    test('renders with no value (defaults to 0% progress)', async ({ mount }) => {
      const component = await mount(<Progress />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute(
        'style',
        'transform: translateX(-100%);'
      )
    })
  })

  test.describe('styling', () => {
    test('has bg-primary/20 background', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveClass(/bg-primary\/20/)
    })

    test('has h-2 height', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveClass(/h-2/)
    })

    test('has w-full width', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveClass(/w-full/)
    })

    test('has rounded-full border radius', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveClass(/rounded-full/)
    })

    test('has overflow-hidden', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveClass(/overflow-hidden/)
    })

    test('has relative positioning', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveClass(/relative/)
    })
  })

  test.describe('indicator', () => {
    test('progress-indicator is present', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toBeVisible()
    })

    test('progress-indicator has data-slot attribute', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute('data-slot', 'progress-indicator')
    })

    test('progress-indicator has bg-primary', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveClass(/bg-primary/)
    })

    test('progress-indicator has full height', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveClass(/h-full/)
    })

    test('indicator uses translateX transform based on value', async ({ mount }) => {
      const component = await mount(<Progress value={75} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute(
        'style',
        'transform: translateX(-25%);'
      )
    })
  })

  test.describe('accessibility', () => {
    test('has progressbar role', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveRole('progressbar')
    })

    test('has aria-valuemin', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveAttribute('aria-valuemin', '0')
    })

    test('has aria-valuemax', async ({ mount }) => {
      const component = await mount(<Progress value={50} />)
      await expect(component).toHaveAttribute('aria-valuemax', '100')
    })

    test('reflects value through indicator transform', async ({ mount }) => {
      const component = await mount(<Progress value={42} />)
      const indicator = component.locator('[data-slot="progress-indicator"]')
      await expect(indicator).toHaveAttribute(
        'style',
        'transform: translateX(-58%);'
      )
    })

    test('supports custom aria-label', async ({ mount }) => {
      const component = await mount(
        <Progress value={50} aria-label="Upload progress" />
      )
      await expect(component).toHaveAccessibleName('Upload progress')
    })

    test('supports aria-valuetext', async ({ mount }) => {
      const component = await mount(
        <Progress value={50} aria-valuetext="50 percent" />
      )
      await expect(component).toHaveAttribute('aria-valuetext', '50 percent')
    })
  })
})

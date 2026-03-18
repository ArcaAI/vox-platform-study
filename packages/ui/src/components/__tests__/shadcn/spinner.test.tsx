import { test, expect } from '@playwright/experimental-ct-react'
import { Spinner } from '../../shadcn/spinner'

test.describe('Spinner', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toBeVisible()
    })

    test('renders as an svg element', async ({ mount }) => {
      const component = await mount(<Spinner />)
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('svg')
    })
  })

  test.describe('styling', () => {
    test('has animate-spin class', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toHaveClass(/animate-spin/)
    })

    test('has size-4 class', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toHaveClass(/size-4/)
    })

    test('has both default classes', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toHaveClass(/size-4/)
      await expect(component).toHaveClass(/animate-spin/)
    })
  })

  test.describe('accessibility', () => {
    test('has role="status"', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toHaveRole('status')
    })

    test('has aria-label="Loading"', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toHaveAttribute('aria-label', 'Loading')
    })

    test('has accessible name', async ({ mount }) => {
      const component = await mount(<Spinner />)
      await expect(component).toHaveAccessibleName('Loading')
    })
  })

  test.describe('custom className', () => {
    test('accepts and merges custom className', async ({ mount }) => {
      const component = await mount(<Spinner className="text-primary" />)
      await expect(component).toHaveClass(/text-primary/)
      await expect(component).toHaveClass(/animate-spin/)
    })

    test('allows overriding size', async ({ mount }) => {
      const component = await mount(<Spinner className="size-8" />)
      await expect(component).toHaveClass(/size-8/)
      await expect(component).toHaveClass(/animate-spin/)
    })

    test('preserves role and aria-label with custom className', async ({
      mount,
    }) => {
      const component = await mount(
        <Spinner className="custom-spinner" />
      )
      await expect(component).toHaveRole('status')
      await expect(component).toHaveAttribute('aria-label', 'Loading')
      await expect(component).toHaveClass(/custom-spinner/)
    })
  })
})

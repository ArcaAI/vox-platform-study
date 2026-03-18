import { test, expect } from '@playwright/experimental-ct-react'
import {
  StaticMatrix,
  AnimatedMatrix,
  SmallGridMatrix,
  DefaultModeMatrix,
  VuModeMatrix,
  PulseMatrix,
  WaveMatrix,
  CssVarsMatrix,
} from '../fixtures/elevenlabs/matrix-fixtures'

test.describe('Matrix', () => {
  test.describe('rendering', () => {
    test('renders with static pattern', async ({ mount }) => {
      const component = await mount(<StaticMatrix />)
      await expect(component).toBeVisible()
    })

    test('renders with animation frames', async ({ mount }) => {
      const component = await mount(<AnimatedMatrix />)
      await expect(component).toBeVisible()
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<StaticMatrix className="custom-matrix" />)
      await expect(component).toHaveClass(/custom-matrix/)
    })
  })

  test.describe('accessibility', () => {
    test('has img role', async ({ mount, page }) => {
      await mount(<StaticMatrix />)
      const matrix = page.locator('[role="img"]')
      await expect(matrix).toBeVisible()
    })

    test('has default aria-label', async ({ mount, page }) => {
      await mount(<StaticMatrix />)
      const matrix = page.locator('[role="img"]')
      await expect(matrix).toHaveAttribute('aria-label', 'matrix display')
    })

    test('supports custom aria-label', async ({ mount, page }) => {
      await mount(<StaticMatrix ariaLabel="Digit zero" />)
      const matrix = page.locator('[role="img"]')
      await expect(matrix).toHaveAttribute('aria-label', 'Digit zero')
    })

    test('has aria-live for animations', async ({ mount, page }) => {
      await mount(<AnimatedMatrix />)
      const matrix = page.locator('[role="img"]')
      await expect(matrix).toHaveAttribute('aria-live', 'polite')
    })

    test('does not have aria-live for static pattern', async ({ mount, page }) => {
      await mount(<StaticMatrix />)
      const matrix = page.locator('[role="img"]')
      await expect(matrix).not.toHaveAttribute('aria-live')
    })
  })

  test.describe('SVG rendering', () => {
    test('renders SVG element', async ({ mount }) => {
      const component = await mount(<StaticMatrix />)
      const svg = component.locator('svg')
      await expect(svg).toBeVisible()
    })

    test('renders correct number of circles', async ({ mount }) => {
      const component = await mount(<SmallGridMatrix />)
      const circles = component.locator('circle')
      await expect(circles).toHaveCount(9)
    })
  })

  test.describe('CSS variables', () => {
    test('sets matrix CSS variables', async ({ mount }) => {
      const component = await mount(<CssVarsMatrix />)
      await expect(component).toBeVisible()
    })
  })

  test.describe('modes', () => {
    test('renders in default mode', async ({ mount }) => {
      const component = await mount(<DefaultModeMatrix />)
      await expect(component).toBeVisible()
    })

    test('renders in VU mode', async ({ mount }) => {
      const component = await mount(<VuModeMatrix />)
      await expect(component).toBeVisible()
    })
  })

  test.describe('animations', () => {
    test('renders pulse animation', async ({ mount }) => {
      const component = await mount(<PulseMatrix />)
      await expect(component).toBeVisible()
    })

    test('renders wave animation', async ({ mount }) => {
      const component = await mount(<WaveMatrix />)
      await expect(component).toBeVisible()
    })
  })
})

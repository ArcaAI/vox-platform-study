import { test, expect } from '@playwright/experimental-ct-react'
import { BarVisualizer } from '../../elevenlabs/bar-visualizer'

test.describe('BarVisualizer', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<BarVisualizer demo />)
      await expect(component).toBeVisible()
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer demo className="custom-visualizer" />
      )
      await expect(component).toHaveClass(/custom-visualizer/)
    })

    test('renders bars', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="speaking" demo barCount={5} />
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('states', () => {
    test('renders connecting state', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="connecting" demo />
      )
      await expect(component).toHaveAttribute('data-state', 'connecting')
    })

    test('renders initializing state', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="initializing" demo />
      )
      await expect(component).toHaveAttribute('data-state', 'initializing')
    })

    test('renders listening state', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="listening" demo />
      )
      await expect(component).toHaveAttribute('data-state', 'listening')
    })

    test('renders speaking state', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="speaking" demo />
      )
      await expect(component).toHaveAttribute('data-state', 'speaking')
    })

    test('renders thinking state', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="thinking" demo />
      )
      await expect(component).toHaveAttribute('data-state', 'thinking')
    })
  })

  test.describe('layout', () => {
    test('has flex layout', async ({ mount }) => {
      const component = await mount(<BarVisualizer demo />)
      await expect(component).toHaveClass(/flex/)
    })

    test('has justify-center', async ({ mount }) => {
      const component = await mount(<BarVisualizer demo />)
      await expect(component).toHaveClass(/justify-center/)
    })

    test('aligns items to end by default', async ({ mount }) => {
      const component = await mount(<BarVisualizer demo />)
      await expect(component).toHaveClass(/items-end/)
    })

    test('aligns items to center when centerAlign is true', async ({
      mount,
    }) => {
      const component = await mount(<BarVisualizer demo centerAlign />)
      await expect(component).toHaveClass(/items-center/)
    })
  })

  test.describe('bar count', () => {
    test('renders with custom bar count', async ({ mount }) => {
      const component = await mount(
        <BarVisualizer state="speaking" demo barCount={10} />
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('styling', () => {
    test('has rounded container', async ({ mount }) => {
      const component = await mount(<BarVisualizer demo />)
      await expect(component).toHaveClass(/rounded-lg/)
    })

    test('has background color', async ({ mount }) => {
      const component = await mount(<BarVisualizer demo />)
      await expect(component).toHaveClass(/bg-muted/)
    })
  })
})

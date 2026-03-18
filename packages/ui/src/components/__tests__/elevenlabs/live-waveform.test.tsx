import { test, expect } from '@playwright/experimental-ct-react'
import { LiveWaveform } from '../../elevenlabs/live-waveform'

test.describe('LiveWaveform', () => {
  test.describe('rendering', () => {
    test('renders waveform container', async ({ mount }) => {
      const component = await mount(<LiveWaveform />)
      await expect(component).toBeVisible()
    })

    test('renders canvas element', async ({ mount }) => {
      const component = await mount(<LiveWaveform />)
      const canvas = component.locator('canvas')
      await expect(canvas).toBeVisible()
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <LiveWaveform className="custom-waveform" />
      )
      await expect(component).toHaveClass(/custom-waveform/)
    })

    test('canvas is aria-hidden', async ({ mount }) => {
      const component = await mount(<LiveWaveform />)
      const canvas = component.locator('canvas')
      await expect(canvas).toHaveAttribute('aria-hidden', 'true')
    })
  })

  test.describe('accessibility', () => {
    test('has img role', async ({ mount }) => {
      const component = await mount(<LiveWaveform />)
      await expect(component).toHaveRole('img')
    })

    test('has idle aria-label when inactive', async ({ mount }) => {
      const component = await mount(<LiveWaveform />)
      await expect(component).toHaveAttribute(
        'aria-label',
        'Audio waveform idle'
      )
    })

    test('has processing aria-label when processing', async ({ mount }) => {
      const component = await mount(<LiveWaveform processing />)
      await expect(component).toHaveAttribute(
        'aria-label',
        'Processing audio'
      )
    })

    test('has active aria-label when active', async ({ mount }) => {
      const component = await mount(<LiveWaveform active />)
      await expect(component).toHaveAttribute(
        'aria-label',
        'Live audio waveform'
      )
    })
  })

  test.describe('idle state', () => {
    test('shows dotted line when idle', async ({ mount }) => {
      const component = await mount(<LiveWaveform />)
      const dottedLine = component.locator('.border-dotted')
      await expect(dottedLine).toBeVisible()
    })

    test('hides dotted line when active', async ({ mount }) => {
      const component = await mount(<LiveWaveform active />)
      const dottedLine = component.locator('.border-dotted')
      await expect(dottedLine).not.toBeVisible()
    })

    test('hides dotted line when processing', async ({ mount }) => {
      const component = await mount(<LiveWaveform processing />)
      const dottedLine = component.locator('.border-dotted')
      await expect(dottedLine).not.toBeVisible()
    })
  })

  test.describe('height', () => {
    test('applies numeric height', async ({ mount }) => {
      const component = await mount(<LiveWaveform height={100} />)
      await expect(component).toBeVisible()
    })

    test('applies string height', async ({ mount }) => {
      const component = await mount(<LiveWaveform height="50px" />)
      await expect(component).toBeVisible()
    })
  })

  test.describe('modes', () => {
    test('renders in static mode', async ({ mount }) => {
      const component = await mount(
        <LiveWaveform processing mode="static" />
      )
      await expect(component).toBeVisible()
    })

    test('renders in scrolling mode', async ({ mount }) => {
      const component = await mount(
        <LiveWaveform processing mode="scrolling" />
      )
      await expect(component).toBeVisible()
    })
  })
})

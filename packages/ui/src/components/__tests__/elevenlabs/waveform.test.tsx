import { test, expect } from '@playwright/experimental-ct-react'
import { Waveform } from '../../elevenlabs/waveform'

const sampleData = [0.2, 0.5, 0.8, 1.0, 0.7, 0.3, 0.1, 0.4, 0.6, 0.9]

test.describe('Waveform', () => {
  test.describe('rendering', () => {
    test('renders waveform container', async ({ mount }) => {
      const component = await mount(<Waveform data={sampleData} />)
      await expect(component).toBeVisible()
    })

    test('renders canvas element', async ({ mount }) => {
      const component = await mount(<Waveform data={sampleData} />)
      const canvas = component.locator('canvas')
      await expect(canvas).toBeVisible()
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} className="custom-waveform" />
      )
      await expect(component).toHaveClass(/custom-waveform/)
    })
  })

  test.describe('height', () => {
    test('applies numeric height', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} height={100} />
      )
      await expect(component).toBeVisible()
    })

    test('applies string height', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} height="50px" />
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('empty data', () => {
    test('renders with empty data array', async ({ mount }) => {
      const component = await mount(<Waveform data={[]} />)
      await expect(component).toBeVisible()
    })

    test('renders with no data prop', async ({ mount }) => {
      const component = await mount(<Waveform />)
      await expect(component).toBeVisible()
    })
  })

  test.describe('bar customization', () => {
    test('renders with custom bar width', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} barWidth={8} />
      )
      await expect(component).toBeVisible()
    })

    test('renders with custom bar gap', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} barGap={4} />
      )
      await expect(component).toBeVisible()
    })

    test('renders with custom bar radius', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} barRadius={0} />
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('fade edges', () => {
    test('renders with fade edges enabled', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} fadeEdges={true} />
      )
      await expect(component).toBeVisible()
    })

    test('renders with fade edges disabled', async ({ mount }) => {
      const component = await mount(
        <Waveform data={sampleData} fadeEdges={false} />
      )
      await expect(component).toBeVisible()
    })
  })
})

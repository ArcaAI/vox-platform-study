import { test, expect } from '@playwright/experimental-ct-react'
import { Orb } from '../../elevenlabs/orb'

test.describe('Orb', () => {
  test.describe('rendering', () => {
    test('renders orb container', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb />
        </div>
      )
      await expect(component).toBeVisible()
    })

    test('renders canvas element', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb />
        </div>
      )
      const canvas = component.locator('canvas')
      await expect(canvas).toBeVisible()
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Orb className="custom-orb" />
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('agent states', () => {
    test('renders with null state', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb agentState={null} />
        </div>
      )
      await expect(component).toBeVisible()
    })

    test('renders with thinking state', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb agentState="thinking" />
        </div>
      )
      await expect(component).toBeVisible()
    })

    test('renders with listening state', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb agentState="listening" />
        </div>
      )
      await expect(component).toBeVisible()
    })

    test('renders with talking state', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb agentState="talking" />
        </div>
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('volume modes', () => {
    test('renders with auto volume mode', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb volumeMode="auto" />
        </div>
      )
      await expect(component).toBeVisible()
    })

    test('renders with manual volume mode', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb volumeMode="manual" manualInput={0.5} manualOutput={0.8} />
        </div>
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('custom colors', () => {
    test('renders with custom colors', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '200px', height: '200px' }}>
          <Orb colors={['#FF0000', '#0000FF']} />
        </div>
      )
      await expect(component).toBeVisible()
    })
  })

  test.describe('sizing', () => {
    test('renders in small container', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '50px', height: '50px' }}>
          <Orb />
        </div>
      )
      await expect(component).toBeVisible()
    })

    test('renders in large container', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '500px', height: '500px' }}>
          <Orb />
        </div>
      )
      await expect(component).toBeVisible()
    })
  })
})

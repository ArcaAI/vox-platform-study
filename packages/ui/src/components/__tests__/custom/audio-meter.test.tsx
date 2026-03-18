import { test, expect } from '@playwright/experimental-ct-react'
import { AudioMeter } from '../../custom/audio-meter'

test.describe('AudioMeter', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={50} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      await expect(component).toHaveAttribute('data-slot', 'audio-meter')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={50} isCapturing={true} isSpeaking={false} isMuted={false} className="custom-class" />
      )
      await expect(component).toHaveClass(/custom-class/)
    })
  })

  test.describe('meter element', () => {
    test('has meter role with correct aria attributes', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={65} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const meter = component.locator('[role="meter"]')
      await expect(meter).toBeVisible()
      await expect(meter).toHaveAttribute('aria-valuenow', '65')
      await expect(meter).toHaveAttribute('aria-valuemin', '0')
      await expect(meter).toHaveAttribute('aria-valuemax', '100')
      await expect(meter).toHaveAttribute('aria-label', 'Audio level')
    })

    test('clamps level above 100', async ({ mount }) => {
      const overMax = await mount(
        <AudioMeter level={150} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      await expect(overMax.locator('[role="meter"]')).toHaveAttribute('aria-valuenow', '100')
    })

    test('clamps level below 0', async ({ mount }) => {
      const underMin = await mount(
        <AudioMeter level={-20} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      await expect(underMin.locator('[role="meter"]')).toHaveAttribute('aria-valuenow', '0')
    })
  })

  test.describe('level colors', () => {
    test('shows green for low levels (<=40)', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={25} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const bar = component.locator('[role="meter"]').locator('div')
      await expect(bar).toHaveClass(/bg-green-500/)
    })

    test('shows yellow for medium levels (41-70)', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={55} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const bar = component.locator('[role="meter"]').locator('div')
      await expect(bar).toHaveClass(/bg-yellow-500/)
    })

    test('shows red for high levels (>70)', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={85} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const bar = component.locator('[role="meter"]').locator('div')
      await expect(bar).toHaveClass(/bg-red-500/)
    })
  })

  test.describe('capturing indicator', () => {
    test('shows pulsing dot when capturing', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={50} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      await expect(component.locator('.animate-pulse')).toBeVisible()
    })

    test('hides pulsing dot when not capturing', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={0} isCapturing={false} isSpeaking={false} isMuted={false} />
      )
      await expect(component.locator('.animate-pulse')).toHaveCount(0)
    })
  })

  test.describe('muted state', () => {
    test('shows muted microphone icon when muted', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={0} isCapturing={false} isSpeaking={false} isMuted={true} />
      )
      await expect(component.locator('.text-destructive')).toBeVisible()
    })

    test('shows normal microphone icon when not muted', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={50} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      await expect(component.locator('.text-muted-foreground').first()).toBeVisible()
    })
  })

  test.describe('speaking indicator', () => {
    test('shows broadcast icon when speaking', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={60} isCapturing={true} isSpeaking={true} isMuted={false} />
      )
      await expect(component.locator('.text-primary').first()).toBeVisible()
    })

    test('hides broadcast icon when not speaking', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={20} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const broadcastIcons = component.locator('svg.text-primary')
      await expect(broadcastIcons).toHaveCount(0)
    })
  })

  test.describe('bar width', () => {
    test('bar width reflects level percentage', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={75} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const bar = component.locator('[role="meter"]').locator('div')
      const style = await bar.getAttribute('style')
      expect(style).toContain('75%')
    })

    test('bar has zero width at level 0', async ({ mount }) => {
      const component = await mount(
        <AudioMeter level={0} isCapturing={true} isSpeaking={false} isMuted={false} />
      )
      const bar = component.locator('[role="meter"]').locator('div')
      const style = await bar.getAttribute('style')
      expect(style).toContain('0%')
    })
  })
})

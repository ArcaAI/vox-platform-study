import { test, expect } from '@playwright/experimental-ct-react'
import {
  DefaultViewer,
  EmptyViewer,
  WithLiveTranscript,
  WithPartialEntry,
  WithoutTimestamps,
  WithoutSpeakers,
  CustomHeightViewer,
} from '../fixtures/custom/transcript-viewer-fixtures'

test.describe('TranscriptViewer', () => {
  test.describe('rendering', () => {
    test('renders transcript entries', async ({ mount }) => {
      const component = await mount(<DefaultViewer />)
      await expect(component.getByText('Hello, how are you?')).toBeVisible()
      await expect(component.getByText('I am doing well, thank you.')).toBeVisible()
    })

    test('shows timestamps', async ({ mount }) => {
      const component = await mount(<DefaultViewer />)
      await expect(component.getByText('09:00:00')).toBeVisible()
      await expect(component.getByText('09:00:05')).toBeVisible()
    })

    test('shows speaker badges', async ({ mount }) => {
      const component = await mount(<DefaultViewer />)
      await expect(component.getByText('Doctor')).toBeVisible()
      await expect(component.getByText('Patient')).toBeVisible()
    })
  })

  test.describe('empty state', () => {
    test('shows empty message when no entries', async ({ mount }) => {
      const component = await mount(<EmptyViewer />)
      await expect(component.getByText('No transcripts yet')).toBeVisible()
    })

    test('shows dashed border in empty state', async ({ mount }) => {
      const component = await mount(<EmptyViewer />)
      await expect(component).toHaveClass(/border-dashed/)
    })
  })

  test.describe('live transcript', () => {
    test('shows current live transcript', async ({ mount }) => {
      const component = await mount(<WithLiveTranscript />)
      await expect(
        component.getByText('I have been feeling a bit tired lately...')
      ).toBeVisible()
    })

    test('shows pulsing indicator for live transcript', async ({ mount }) => {
      const component = await mount(<WithLiveTranscript />)
      await expect(component.locator('.animate-ping')).toBeVisible()
    })
  })

  test.describe('partial entries', () => {
    test('renders non-final entries with reduced opacity', async ({ mount }) => {
      const component = await mount(<WithPartialEntry />)
      const partialEntry = component.locator('.opacity-60')
      await expect(partialEntry).toBeVisible()
    })

    test('renders non-final entry text in italic', async ({ mount }) => {
      const component = await mount(<WithPartialEntry />)
      await expect(component.getByText('Let me check your...')).toHaveClass(/italic/)
    })
  })

  test.describe('optional fields', () => {
    test('renders without timestamps', async ({ mount }) => {
      const component = await mount(<WithoutTimestamps />)
      await expect(component.getByText('Hello, how are you?')).toBeVisible()
      await expect(component.getByText('09:00:00')).toHaveCount(0)
    })

    test('renders without speakers', async ({ mount }) => {
      const component = await mount(<WithoutSpeakers />)
      await expect(component.getByText('Hello, how are you?')).toBeVisible()
      const doctorBadges = component.locator('[data-slot="badge"]').filter({ hasText: 'Doctor' })
      await expect(doctorBadges).toHaveCount(0)
    })
  })

  test.describe('custom height', () => {
    test('applies custom maxHeight', async ({ mount }) => {
      const component = await mount(<CustomHeightViewer />)
      await expect(component).toHaveAttribute('data-slot', 'scroll-area')
      await expect(component).toHaveCSS('max-height', '150px')
    })
  })

  test.describe('accessibility', () => {
    test('transcript text is readable', async ({ mount }) => {
      const component = await mount(<DefaultViewer />)
      await expect(component.getByText('Hello, how are you?')).toBeVisible()
      await expect(component.getByText('I am doing well, thank you.')).toBeVisible()
    })

    test('speaker badges provide context', async ({ mount }) => {
      const component = await mount(<DefaultViewer />)
      const badges = component.locator('[data-slot="badge"]')
      expect(await badges.count()).toBeGreaterThan(0)
    })
  })
})

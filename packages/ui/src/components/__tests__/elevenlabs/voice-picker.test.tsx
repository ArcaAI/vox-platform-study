import { test, expect } from '@playwright/experimental-ct-react'
import {
  VoicePickerFixture,
  EmptyVoicePickerFixture,
} from '../fixtures/elevenlabs/voice-picker-fixtures'

test.describe('VoicePicker', () => {
  test.describe('rendering', () => {
    test('renders trigger button', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await expect(trigger).toBeVisible()
    })

    test('shows placeholder when no value', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await expect(trigger).toContainText('Select a voice...')
    })

    test('shows custom placeholder', async ({ mount, page }) => {
      await mount(<VoicePickerFixture placeholder="Pick a voice" />)
      const trigger = page.getByRole('combobox')
      await expect(trigger).toContainText('Pick a voice')
    })

    test('shows selected voice name', async ({ mount, page }) => {
      await mount(<VoicePickerFixture value="voice-1" />)
      const trigger = page.getByRole('combobox')
      await expect(trigger).toContainText('Rachel')
    })
  })

  test.describe('accessibility', () => {
    test('trigger has combobox role', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await expect(trigger).toBeVisible()
    })

    test('trigger has aria-expanded attribute', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    })
  })

  test.describe('dropdown', () => {
    test('opens dropdown on click', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await trigger.click()
      await expect(page.getByPlaceholder('Search voices...')).toBeVisible()
    })

    test('shows voice list in dropdown', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await trigger.click()
      await expect(page.getByText('Rachel')).toBeVisible()
      await expect(page.getByText('Drew')).toBeVisible()
      await expect(page.getByText('Clyde')).toBeVisible()
    })

    test('shows voice labels', async ({ mount, page }) => {
      await mount(<VoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await trigger.click()
      await expect(page.getByText('American').first()).toBeVisible()
    })

    test('shows empty state for no voices', async ({ mount, page }) => {
      await mount(<EmptyVoicePickerFixture />)
      const trigger = page.getByRole('combobox')
      await trigger.click()
      await expect(page.getByText('No voice found.')).toBeVisible()
    })
  })
})

import { test, expect } from '@playwright/experimental-ct-react'
import {
  BasicSpeechInput,
  RecordOnlySpeechInput,
  SmallSpeechInput,
  LargeSpeechInput,
} from '../fixtures/elevenlabs/speech-input-fixtures'

test.describe('SpeechInput', () => {
  test.describe('rendering', () => {
    test('renders speech input container', async ({ mount }) => {
      const component = await mount(<BasicSpeechInput />)
      await expect(component).toBeVisible()
    })

    test('renders record button', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const button = page.getByTestId('record-button')
      await expect(button).toBeVisible()
    })

    test('renders preview area', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const preview = page.getByTestId('preview')
      await expect(preview).toBeAttached()
    })

    test('renders cancel button', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const cancel = page.getByTestId('cancel-button')
      await expect(cancel).toBeAttached()
    })
  })

  test.describe('record button', () => {
    test('has button role', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const button = page.getByTestId('record-button')
      await expect(button).toHaveRole('button')
    })

    test('has start recording label when idle', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const button = page.getByTestId('record-button')
      await expect(button).toHaveAttribute('aria-label', 'Start recording')
    })
  })

  test.describe('cancel button', () => {
    test('has cancel recording label', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const cancel = page.getByTestId('cancel-button')
      await expect(cancel).toHaveAttribute('aria-label', 'Cancel recording')
    })
  })

  test.describe('layout', () => {
    test('container has inline-flex display', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const container = page.locator('.inline-flex').first()
      await expect(container).toBeAttached()
    })

    test('container has rounded border', async ({ mount, page }) => {
      await mount(<BasicSpeechInput />)
      const container = page.locator('.rounded-lg').first()
      await expect(container).toBeAttached()
    })
  })

  test.describe('sizes', () => {
    test('renders default size', async ({ mount }) => {
      const component = await mount(<BasicSpeechInput />)
      await expect(component).toBeVisible()
    })

    test('renders small size', async ({ mount }) => {
      const component = await mount(<SmallSpeechInput />)
      await expect(component).toBeVisible()
    })

    test('renders large size', async ({ mount }) => {
      const component = await mount(<LargeSpeechInput />)
      await expect(component).toBeVisible()
    })
  })

  test.describe('record only', () => {
    test('renders without preview and cancel', async ({ mount, page }) => {
      await mount(<RecordOnlySpeechInput />)
      const button = page.getByTestId('record-button')
      await expect(button).toBeVisible()
    })
  })
})

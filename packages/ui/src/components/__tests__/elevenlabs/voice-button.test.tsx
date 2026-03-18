import { test, expect } from '@playwright/experimental-ct-react'
import { VoiceButton } from '../../elevenlabs/voice-button'
import {
  BasicVoiceButton,
  VoiceButtonWithCallbacks,
  IconVoiceButton,
  DisabledVoiceButton,
} from '../fixtures/elevenlabs/voice-button-fixtures'

test.describe('VoiceButton', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(<BasicVoiceButton />)
      await expect(component).toBeVisible()
    })

    test('renders label text', async ({ mount }) => {
      const component = await mount(<BasicVoiceButton />)
      await expect(component).toContainText('Voice Input')
    })

    test('renders as button element', async ({ mount, page }) => {
      await mount(<BasicVoiceButton />)
      const button = page.getByTestId('voice-button')
      await expect(button).toHaveRole('button')
    })

    test('has accessible name', async ({ mount, page }) => {
      await mount(<BasicVoiceButton />)
      const button = page.getByTestId('voice-button')
      await expect(button).toHaveAttribute('aria-label', 'Voice Button')
    })
  })

  test.describe('states', () => {
    test('renders idle state', async ({ mount, page }) => {
      await mount(<BasicVoiceButton state="idle" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeVisible()
    })

    test('renders recording state', async ({ mount, page }) => {
      await mount(<BasicVoiceButton state="recording" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeVisible()
    })

    test('renders processing state', async ({ mount, page }) => {
      await mount(<BasicVoiceButton state="processing" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeDisabled()
    })

    test('renders success state', async ({ mount, page }) => {
      await mount(<BasicVoiceButton state="success" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeVisible()
    })

    test('renders error state', async ({ mount, page }) => {
      await mount(<BasicVoiceButton state="error" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeVisible()
    })
  })

  test.describe('disabled', () => {
    test('renders disabled state', async ({ mount, page }) => {
      await mount(<DisabledVoiceButton />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeDisabled()
    })

    test('processing state disables button', async ({ mount, page }) => {
      await mount(<BasicVoiceButton state="processing" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeDisabled()
    })
  })

  test.describe('interactions', () => {
    test('handles click events', async ({ mount, page }) => {
      await mount(<VoiceButtonWithCallbacks />)
      const button = page.getByTestId('voice-button')
      await button.click()
      const action = page.getByTestId('last-action')
      await expect(action).toHaveText('pressed')
    })
  })

  test.describe('icon size', () => {
    test('renders icon size button', async ({ mount, page }) => {
      await mount(<IconVoiceButton />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeVisible()
    })

    test('icon button renders in recording state', async ({ mount, page }) => {
      await mount(<IconVoiceButton state="recording" />)
      const button = page.getByTestId('voice-button')
      await expect(button).toBeVisible()
    })
  })

  test.describe('variants', () => {
    test('renders outline variant', async ({ mount }) => {
      const component = await mount(
        <VoiceButton variant="outline" label="Outline" />
      )
      await expect(component).toBeVisible()
    })

    test('renders secondary variant', async ({ mount }) => {
      const component = await mount(
        <VoiceButton variant="secondary" label="Secondary" />
      )
      await expect(component).toBeVisible()
    })

    test('renders ghost variant', async ({ mount }) => {
      const component = await mount(
        <VoiceButton variant="ghost" label="Ghost" />
      )
      await expect(component).toBeVisible()
    })
  })
})

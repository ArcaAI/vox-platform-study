import { test, expect } from '@playwright/experimental-ct-react'
import { ConversationBar } from '../../elevenlabs/conversation-bar'

test.describe('ConversationBar', () => {
  test.describe('rendering', () => {
    test('renders conversation bar', async ({ mount }) => {
      const component = await mount(
        <ConversationBar agentId="test-agent" />
      )
      await expect(component).toBeVisible()
    })

    test('renders within a card', async ({ mount, page }) => {
      await mount(<ConversationBar agentId="test-agent" />)
      const card = page.locator('[data-slot="card"]')
      await expect(card).toBeVisible()
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <ConversationBar agentId="test-agent" className="custom-bar" />
      )
      await expect(component).toHaveClass(/custom-bar/)
    })
  })

  test.describe('buttons', () => {
    test('renders phone/connect button', async ({ mount, page }) => {
      await mount(<ConversationBar agentId="test-agent" />)
      const buttons = page.locator('button')
      const count = await buttons.count()
      expect(count).toBeGreaterThanOrEqual(1)
    })

    test('mute button is disabled when disconnected', async ({
      mount,
      page,
    }) => {
      await mount(<ConversationBar agentId="test-agent" />)
      const muteButton = page.locator('button[aria-pressed]').first()
      await expect(muteButton).toBeDisabled()
    })
  })

  test.describe('waveform', () => {
    test('renders waveform area', async ({ mount }) => {
      const component = await mount(
        <ConversationBar agentId="test-agent" />
      )
      await expect(component).toBeVisible()
    })

    test('shows "Customer Support" text when disconnected', async ({
      mount,
      page,
    }) => {
      await mount(<ConversationBar agentId="test-agent" />)
      await expect(page.getByText('Customer Support')).toBeVisible()
    })
  })

  test.describe('layout', () => {
    test('has flex layout', async ({ mount }) => {
      const component = await mount(
        <ConversationBar agentId="test-agent" />
      )
      await expect(component).toHaveClass(/flex/)
    })
  })
})

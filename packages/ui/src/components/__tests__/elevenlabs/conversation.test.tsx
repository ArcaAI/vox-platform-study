import { test, expect } from '@playwright/experimental-ct-react'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from '../../elevenlabs/conversation'
import {
  EmptyConversation,
  CustomEmptyConversation,
  ConversationWithMessages,
} from '../fixtures/elevenlabs/conversation-fixtures'

test.describe('Conversation', () => {
  test.describe('rendering', () => {
    test('renders conversation container', async ({ mount }) => {
      const component = await mount(<EmptyConversation />)
      await expect(component).toBeVisible()
    })

    test('has log role for accessibility', async ({ mount, page }) => {
      await mount(<EmptyConversation />)
      const log = page.getByRole('log')
      await expect(log).toBeVisible()
    })
  })

  test.describe('empty state', () => {
    test('renders default empty state', async ({ mount }) => {
      const component = await mount(<EmptyConversation />)
      await expect(component).toContainText('No messages yet')
      await expect(component).toContainText(
        'Start a conversation to see messages here'
      )
    })

    test('renders custom empty state', async ({ mount }) => {
      const component = await mount(<CustomEmptyConversation />)
      await expect(component).toContainText('Custom Title')
      await expect(component).toContainText('Custom description text')
    })

    test('renders empty state with custom icon', async ({ mount }) => {
      const component = await mount(
        <div style={{ height: '400px' }}>
          <Conversation>
            <ConversationContent>
              <ConversationEmptyState
                icon={<span data-testid="custom-icon">🎤</span>}
              />
            </ConversationContent>
          </Conversation>
        </div>
      )
      const icon = component.locator('[data-testid="custom-icon"]')
      await expect(icon).toBeVisible()
    })
  })

  test.describe('with messages', () => {
    test('renders messages', async ({ mount }) => {
      const component = await mount(<ConversationWithMessages />)
      await expect(component).toContainText('User message')
      await expect(component).toContainText('Assistant response')
    })
  })

  test.describe('styling', () => {
    test('applies custom className to empty state', async ({ mount }) => {
      const component = await mount(
        <div style={{ height: '400px' }}>
          <Conversation>
            <ConversationContent>
              <ConversationEmptyState className="custom-empty" />
            </ConversationContent>
          </Conversation>
        </div>
      )
      const emptyState = component.locator('.custom-empty')
      await expect(emptyState).toBeVisible()
    })
  })
})

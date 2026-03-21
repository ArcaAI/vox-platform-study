import { test, expect } from '@playwright/experimental-ct-react'
import {
  Message,
  MessageContent,
  MessageAvatar,
} from '../../elevenlabs/message'
import {
  UserMessage,
  AssistantMessage,
  MessageWithAvatar,
  FlatMessage,
  ContainedMessage,
} from '../fixtures/elevenlabs/message-fixtures'

test.describe('Message', () => {
  test.describe('rendering', () => {
    test('renders user message', async ({ mount }) => {
      const component = await mount(<UserMessage />)
      await expect(component).toBeVisible()
      await expect(component).toContainText('Hello from user')
    })

    test('renders assistant message', async ({ mount }) => {
      const component = await mount(<AssistantMessage />)
      await expect(component).toBeVisible()
      await expect(component).toContainText('Hello from assistant')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Message from="user" className="custom-class">
          <MessageContent>Test</MessageContent>
        </Message>
      )
      await expect(component).toHaveClass(/custom-class/)
    })
  })

  test.describe('from prop', () => {
    test('user message has is-user class', async ({ mount }) => {
      const component = await mount(
        <Message from="user">
          <MessageContent>User</MessageContent>
        </Message>
      )
      await expect(component).toHaveClass(/is-user/)
    })

    test('assistant message has is-assistant class', async ({ mount }) => {
      const component = await mount(
        <Message from="assistant">
          <MessageContent>Assistant</MessageContent>
        </Message>
      )
      await expect(component).toHaveClass(/is-assistant/)
    })
  })

  test.describe('MessageContent variants', () => {
    test('renders contained variant', async ({ mount }) => {
      const component = await mount(<ContainedMessage />)
      await expect(component).toContainText('Contained variant message')
    })

    test('renders flat variant', async ({ mount }) => {
      const component = await mount(<FlatMessage />)
      await expect(component).toContainText('Flat variant message')
    })

    test('applies custom className to content', async ({ mount }) => {
      const component = await mount(
        <Message from="user">
          <MessageContent className="custom-content">Test</MessageContent>
        </Message>
      )
      const content = component.locator('.custom-content')
      await expect(content).toBeVisible()
    })
  })

  test.describe('MessageAvatar', () => {
    test('renders avatar with image', async ({ mount }) => {
      const component = await mount(<MessageWithAvatar />)
      await expect(component).toBeVisible()
    })

    test('renders avatar fallback text', async ({ mount }) => {
      const component = await mount(
        <Message from="user">
          <MessageAvatar src="" name="John" />
          <MessageContent>Test</MessageContent>
        </Message>
      )
      await expect(component).toContainText('Jo')
    })

    test('renders default fallback when no name', async ({ mount }) => {
      const component = await mount(
        <Message from="user">
          <MessageAvatar src="" />
          <MessageContent>Test</MessageContent>
        </Message>
      )
      await expect(component).toContainText('ME')
    })
  })

  test.describe('layout', () => {
    test('message has flex layout', async ({ mount }) => {
      const component = await mount(
        <Message from="user">
          <MessageContent>Test</MessageContent>
        </Message>
      )
      await expect(component).toHaveClass(/flex/)
    })

    test('message has gap between elements', async ({ mount }) => {
      const component = await mount(
        <Message from="user">
          <MessageContent>Test</MessageContent>
        </Message>
      )
      await expect(component).toHaveClass(/gap-2/)
    })
  })
})

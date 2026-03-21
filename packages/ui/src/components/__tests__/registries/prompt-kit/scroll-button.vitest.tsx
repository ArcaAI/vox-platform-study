import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ScrollButton } from '../../../registries/prompt-kit/scroll-button'
import { ChatContainerRoot, ChatContainerContent } from '../../../registries/prompt-kit/chat-container'

describe('ScrollButton', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ChatContainerRoot>
        <ChatContainerContent>Content</ChatContainerContent>
        <ScrollButton />
      </ChatContainerRoot>,
    )
    expect(container.querySelector('button')).toBeTruthy()
  })
})

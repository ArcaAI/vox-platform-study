import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ChatConversation } from '../../../registries/manifest/chat-conversation'

describe('ChatConversation', () => {
  it('renders without crashing', () => {
    const { container } = render(<ChatConversation />)
    expect(container.firstChild).toBeTruthy()
  })
})

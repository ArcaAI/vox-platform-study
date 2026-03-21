import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MessageBubble } from '../../../registries/manifest/message-bubble'

describe('MessageBubble', () => {
  it('renders without crashing', () => {
    const { container } = render(<MessageBubble />)
    expect(container.firstChild).toBeTruthy()
  })
})

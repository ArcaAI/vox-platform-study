import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { QuickReply } from '../../../registries/manifest/quick-reply'

describe('QuickReply', () => {
  it('renders without crashing', () => {
    const { container } = render(<QuickReply />)
    expect(container.firstChild).toBeTruthy()
  })
})

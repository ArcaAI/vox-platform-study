import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { GlassAvatar, GlassAvatarFallback } from '@/components/registries/einui/glass-avatar'

describe('GlassAvatar', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <GlassAvatar>
        <GlassAvatarFallback>AB</GlassAvatarFallback>
      </GlassAvatar>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})

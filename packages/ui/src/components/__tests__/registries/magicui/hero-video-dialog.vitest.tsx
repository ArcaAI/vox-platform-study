import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HeroVideoDialog } from '../../../registries/magicui/hero-video-dialog'

describe('HeroVideoDialog', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <HeroVideoDialog
        videoSrc="https://example.com"
        thumbnailSrc="https://example.com/img.jpg"
        thumbnailAlt="test"
        animationStyle="from-center"
      />
    )
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MediaPlayer } from '@/components/registries/diceui/media-player'

describe('MediaPlayer', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <MediaPlayer>
        <div>Player</div>
      </MediaPlayer>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})

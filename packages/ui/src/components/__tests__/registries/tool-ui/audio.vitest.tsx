import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Audio } from '../../../registries/tool-ui/audio'

describe('Audio', () => {
  it('renders without crashing', () => {
    const { container } = render(<Audio id="1" assetId="asset-1" src="https://example.com/audio.mp3" />)
    expect(container.firstChild).toBeTruthy()
  })
})

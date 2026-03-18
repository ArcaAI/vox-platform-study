import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Progress, ProgressTrack, ProgressIndicator } from '../../../registries/basecn/progress'

describe('Progress', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Progress value={50}>
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

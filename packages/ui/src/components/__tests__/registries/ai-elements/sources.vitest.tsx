import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
} from '../../../registries/ai-elements/sources'

describe('Sources', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Sources>
        <SourcesTrigger count={2} />
        <SourcesContent>
          <Source href="https://example.com" title="Example" />
        </SourcesContent>
      </Sources>
    )
    expect(container.firstChild).toBeTruthy()
  })

  it('displays the source count', () => {
    const { getByText } = render(
      <Sources>
        <SourcesTrigger count={3} />
      </Sources>
    )
    expect(getByText('Used 3 sources')).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Tool } from '../../../registries/prompt-kit/tool'

describe('Tool', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Tool
        toolPart={{
          type: 'search',
          state: 'output-available',
          input: { query: 'test' },
          output: { results: [] },
        }}
      />,
    )
    expect(container.firstChild).toBeTruthy()
  })
})

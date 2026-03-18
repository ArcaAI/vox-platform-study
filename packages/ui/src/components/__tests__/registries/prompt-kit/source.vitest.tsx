import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Source,
  SourceTrigger,
  SourceContent,
} from '../../../registries/prompt-kit/source'

describe('Source', () => {
  it('renders without crashing', () => {
    render(
      <Source href="https://example.com">
        <SourceTrigger label="1" />
        <SourceContent title="Example" description="A source" />
      </Source>,
    )
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Terminal } from '../../../registries/tool-ui/terminal'

describe('Terminal', () => {
  it('renders without crashing', () => {
    render(<Terminal id="1" command="npm install" stdout="added 150 packages" exitCode={0} />)
    expect(screen.getByText(/npm install/)).toBeInTheDocument()
  })
})

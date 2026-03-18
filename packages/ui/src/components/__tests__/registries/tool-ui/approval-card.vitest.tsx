import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApprovalCard } from '../../../registries/tool-ui/approval-card'

describe('ApprovalCard', () => {
  it('renders without crashing', () => {
    render(<ApprovalCard id="1" title="Approve deployment" />)
    expect(screen.getByText('Approve deployment')).toBeInTheDocument()
  })
})

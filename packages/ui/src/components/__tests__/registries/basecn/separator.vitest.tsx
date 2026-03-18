import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Separator } from '../../../registries/basecn/separator'

describe('Separator', () => {
  it('renders without crashing', () => {
    const { container } = render(<Separator />)
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Button } from '../../../registries/basecn/button'

describe('Button', () => {
  it('renders without crashing', () => {
    const { container } = render(<Button>Click me</Button>)
    expect(container.firstChild).toBeTruthy()
  })

  it('renders the button text', () => {
    const { getByText } = render(<Button>Submit</Button>)
    expect(getByText('Submit')).toBeTruthy()
  })
})

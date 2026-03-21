import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Slider } from '../../../registries/basecn/slider'

describe('Slider', () => {
  it('renders without crashing', () => {
    const { container } = render(<Slider defaultValue={[50]} />)
    expect(container.firstChild).toBeTruthy()
  })
})

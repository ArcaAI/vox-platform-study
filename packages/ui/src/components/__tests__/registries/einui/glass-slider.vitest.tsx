import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { GlassSlider } from '@/components/registries/einui/glass-slider'

describe('GlassSlider', () => {
  it('renders without crashing', () => {
    const { container } = render(<GlassSlider defaultValue={[50]} />)
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { GlassSwitch } from '@/components/registries/einui/glass-switch'

describe('GlassSwitch', () => {
  it('renders without crashing', () => {
    const { container } = render(<GlassSwitch />)
    expect(container.firstChild).toBeTruthy()
  })
})

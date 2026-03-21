import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LineShadowText } from '../../../registries/magicui/line-shadow-text'

describe('LineShadowText', () => {
  it('renders without crashing', () => {
    const { container } = render(<LineShadowText>Test</LineShadowText>)
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Meteors } from '../../../registries/magicui/meteors'

describe('Meteors', () => {
  it('renders without crashing', () => {
    const { container } = render(<Meteors />)
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { WordRotate } from '../../../registries/magicui/word-rotate'

describe('WordRotate', () => {
  it('renders without crashing', () => {
    const { container } = render(<WordRotate words={["Hello", "World"]} />)
    expect(container.firstChild).toBeTruthy()
  })
})

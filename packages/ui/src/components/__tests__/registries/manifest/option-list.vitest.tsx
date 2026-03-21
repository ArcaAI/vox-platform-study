import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { OptionList } from '../../../registries/manifest/option-list'

describe('OptionList', () => {
  it('renders without crashing', () => {
    const { container } = render(<OptionList />)
    expect(container.firstChild).toBeTruthy()
  })
})

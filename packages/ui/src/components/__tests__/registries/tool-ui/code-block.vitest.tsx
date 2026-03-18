import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CodeBlock } from '../../../registries/tool-ui/code-block'

describe('CodeBlock', () => {
  it('renders without crashing', () => {
    const { container } = render(<CodeBlock id="1" code="console.log('hello')" language="javascript" lineNumbers="hidden" />)
    expect(container.firstChild).toBeTruthy()
  })
})

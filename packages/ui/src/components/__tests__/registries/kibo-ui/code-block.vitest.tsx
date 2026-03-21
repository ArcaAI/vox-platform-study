import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CodeBlock, CodeBlockBody, CodeBlockItem, CodeBlockContent } from '../../../registries/kibo-ui/code-block'

describe('CodeBlock', () => {
  it('renders without crashing', () => {
    const data = [{ language: 'ts', filename: 'test.ts', code: 'const x = 1;' }]
    const { container } = render(
      <CodeBlock data={data} defaultValue="ts">
        <CodeBlockBody>
          {(item) => (
            <CodeBlockItem key={item.language} value={item.language}>
              <CodeBlockContent language="typescript">{item.code}</CodeBlockContent>
            </CodeBlockItem>
          )}
        </CodeBlockBody>
      </CodeBlock>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

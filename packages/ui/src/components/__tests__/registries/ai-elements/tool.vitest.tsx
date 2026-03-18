import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from '../../../registries/ai-elements/tool'

describe('Tool', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Tool>
        <ToolHeader
          type="tool-invocation"
          state="output-available"
          title="Test Tool"
        />
      </Tool>
    )
    expect(container.firstChild).toBeTruthy()
  })

  it('renders tool content when open', () => {
    const { container } = render(
      <Tool defaultOpen>
        <ToolHeader
          type="tool-invocation"
          state="output-available"
          title="Test"
        />
        <ToolContent>
          <ToolInput input={{ key: 'value' }} />
          <ToolOutput output={{ result: 'ok' }} errorText={undefined} />
        </ToolContent>
      </Tool>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

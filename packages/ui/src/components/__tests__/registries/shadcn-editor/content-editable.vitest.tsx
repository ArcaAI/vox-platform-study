import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { ContentEditable } from '../../../registries/shadcn-editor/editor-ui/content-editable'
import { nodes } from '../../../registries/shadcn-editor/nodes'
import { editorTheme } from '../../../registries/shadcn-editor/themes/editor-theme'

const editorConfig = {
  namespace: 'ContentEditableTest',
  theme: editorTheme,
  nodes,
  onError: (error: Error) => console.error(error),
}

const renderWithComposer = (placeholder: string, className?: string) =>
  render(
    <LexicalComposer initialConfig={editorConfig}>
      <RichTextPlugin
        contentEditable={
          <ContentEditable placeholder={placeholder} className={className} />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
    </LexicalComposer>
  )

describe('ContentEditable', () => {
  it('renders without crashing', () => {
    const { container } = renderWithComposer('Type here...')
    expect(container.firstChild).toBeTruthy()
  })

  it('renders the placeholder text', () => {
    const { container } = renderWithComposer('Start typing ...')
    expect(container.textContent).toContain('Start typing ...')
  })

  it('renders a contenteditable element', () => {
    const { container } = renderWithComposer('Type here...')
    const editable = container.querySelector('[contenteditable]')
    expect(editable).toBeTruthy()
  })

  it('applies custom className when provided', () => {
    const customClass = 'custom-editor-class'
    const { container } = renderWithComposer('Type here...', customClass)
    const editable = container.querySelector('[contenteditable]')
    expect(editable?.className).toContain(customClass)
  })
})

import type { Meta, StoryObj } from '@storybook/react-vite'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'

import { ContentEditable } from '../../../registries/shadcn-editor/editor-ui/content-editable'
import { nodes } from '../../../registries/shadcn-editor/nodes'
import { editorTheme } from '../../../registries/shadcn-editor/themes/editor-theme'

const editorConfig = {
  namespace: 'ContentEditableStory',
  theme: editorTheme,
  nodes,
  onError: (error: Error) => console.error(error),
}

const meta = {
  title: 'Registries/ShadcnEditor/ContentEditable',
  component: ContentEditable,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <LexicalComposer initialConfig={editorConfig}>
        <div className="overflow-hidden rounded-lg border shadow" style={{ width: 500 }}>
          <RichTextPlugin
            contentEditable={<Story />}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
      </LexicalComposer>
    ),
  ],
} satisfies Meta<typeof ContentEditable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    placeholder: 'Start typing ...',
  },
}

export const CustomPlaceholder: Story = {
  args: {
    placeholder: 'Write your thoughts here...',
  },
}

export const WithCustomClass: Story = {
  args: {
    placeholder: 'Custom styled editor',
    className: 'min-h-40 px-4 py-2 focus:outline-none',
  },
}

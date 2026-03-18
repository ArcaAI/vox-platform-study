import type { Meta, StoryObj } from '@storybook/react-vite'

import { Editor } from '../../../registries/shadcn-editor/editor'

const meta = {
  title: 'Registries/ShadcnEditor/Editor',
  component: Editor,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Editor>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
}

export const WithOnChange: Story = {
  args: {
    onChange: (editorState) => console.log('Editor state changed:', editorState),
  },
}

export const WithSerializedChange: Story = {
  args: {
    onSerializedChange: (serialized) =>
      console.log('Serialized state:', serialized),
  },
}

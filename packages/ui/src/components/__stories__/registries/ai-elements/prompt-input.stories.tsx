import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
  PromptInputButton,
} from '../../../registries/ai-elements/prompt-input'

const meta = {
  title: 'Registries/AiElements/PromptInput',
  component: PromptInput,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PromptInput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <PromptInput onSubmit={(msg) => console.log(msg)}>
        <PromptInputTextarea placeholder="Ask anything..." />
        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
    </div>
  ),
}

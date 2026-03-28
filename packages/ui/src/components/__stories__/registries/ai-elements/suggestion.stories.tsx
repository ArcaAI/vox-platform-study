import type { Meta, StoryObj } from '@storybook/react-vite';

import { Suggestions, Suggestion } from '../../../registries/ai-elements/suggestion';

const meta = {
  title: 'Registries/AiElements/Suggestion',
  component: Suggestions,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Suggestions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Suggestions>
        <Suggestion suggestion="Tell me about React hooks" />
        <Suggestion suggestion="How do I use TypeScript?" />
        <Suggestion suggestion="Explain server components" />
        <Suggestion suggestion="What is Tailwind CSS?" />
      </Suggestions>
    </div>
  ),
};

import type { Meta, StoryObj } from '@storybook/react-vite';

import { PromptSuggestion } from '../../../registries/prompt-kit/prompt-suggestion';

const meta = {
  title: 'Registries/PromptKit/PromptSuggestion',
  component: PromptSuggestion,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PromptSuggestion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Suggest a follow-up question',
  },
};

export const WithHighlight: Story = {
  args: {
    children: 'Explain quantum computing in simple terms',
    highlight: 'quantum',
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Source, SourceContent, SourceTrigger } from '../../../registries/prompt-kit/source';

const meta = {
  title: 'Registries/PromptKit/Source',
  component: Source,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Source>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <Source href="https://example.com/article">
      <SourceTrigger label="example.com" />
      <SourceContent title="Example Article Title" description="This is a sample description of the source content." />
    </Source>
  ),
};

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Loader } from '../../../registries/prompt-kit/loader';

const meta = {
  title: 'Registries/PromptKit/Loader',
  component: Loader,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Loader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

const variants = [
  'circular',
  'classic',
  'pulse',
  'pulse-dot',
  'dots',
  'typing',
  'wave',
  'bars',
  'terminal',
  'text-blink',
  'text-shimmer',
  'loading-dots',
] as const;

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-8">
      {variants.map((variant) => (
        <div key={variant} className="flex flex-col items-center gap-2">
          <Loader variant={variant} text={['text-blink', 'text-shimmer', 'loading-dots'].includes(variant) ? 'Thinking' : undefined} />
          <span className="text-xs text-muted-foreground">{variant}</span>
        </div>
      ))}
    </div>
  ),
};

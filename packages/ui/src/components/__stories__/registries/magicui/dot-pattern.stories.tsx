import type { Meta, StoryObj } from '@storybook/react-vite';

import { DotPattern } from '../../../registries/magicui/dot-pattern';

const meta = {
  title: 'Registries/MagicUI/DotPattern',
  component: DotPattern,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof DotPattern>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-screen w-full overflow-hidden">
      <DotPattern />
    </div>
  ),
};

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Globe } from '../../../registries/magicui/globe';

const meta = {
  title: 'Registries/MagicUI/Globe',
  component: Globe,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Globe>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-96 w-96">
      <Globe className="h-full w-full" />
    </div>
  ),
};

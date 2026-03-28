import type { Meta, StoryObj } from '@storybook/react-vite';

import { BorderBeam } from '../../../registries/magicui/border-beam';

const meta = {
  title: 'Registries/MagicUI/BorderBeam',
  component: BorderBeam,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof BorderBeam>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-48 w-96 rounded-xl border bg-background overflow-hidden">
      <BorderBeam />
    </div>
  ),
};

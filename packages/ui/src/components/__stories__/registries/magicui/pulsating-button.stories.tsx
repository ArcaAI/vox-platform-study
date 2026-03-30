import type { Meta, StoryObj } from '@storybook/react-vite';

import { PulsatingButton } from '../../../registries/magicui/pulsating-button';

const meta = {
  title: 'Registries/MagicUI/PulsatingButton',
  component: PulsatingButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PulsatingButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Pulsating',
  },
};

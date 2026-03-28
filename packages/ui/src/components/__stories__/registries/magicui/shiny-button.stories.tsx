import type { Meta, StoryObj } from '@storybook/react-vite';

import { ShinyButton } from '../../../registries/magicui/shiny-button';

const meta = {
  title: 'Registries/MagicUI/ShinyButton',
  component: ShinyButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ShinyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Shiny',
  },
};

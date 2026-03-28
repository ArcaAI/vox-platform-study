import type { Meta, StoryObj } from '@storybook/react-vite';

import { Spinner } from '../../../registries/kibo-ui/spinner';

const meta = {
  title: 'Registries/KiboUI/Spinner',
  component: Spinner,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const Throbber: Story = {
  args: { variant: 'throbber' },
};

export const Pinwheel: Story = {
  args: { variant: 'pinwheel' },
};

export const Ellipsis: Story = {
  args: { variant: 'ellipsis' },
};

export const Ring: Story = {
  args: { variant: 'ring' },
};

export const Bars: Story = {
  args: { variant: 'bars' },
};

export const Infinite: Story = {
  args: { variant: 'infinite' },
};

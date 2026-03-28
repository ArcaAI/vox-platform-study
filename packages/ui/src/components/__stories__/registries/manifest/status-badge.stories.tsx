import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusBadge } from '../../../registries/manifest/status-badge';

const meta = {
  title: 'Registries/Manifest/StatusBadge',
  component: StatusBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StatusBadge />,
};

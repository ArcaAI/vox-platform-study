import type { Meta, StoryObj } from '@storybook/react-vite';

import { LinkPreview } from '../../../registries/tool-ui/link-preview';

const meta = {
  title: 'Registries/ToolUI/LinkPreview',
  component: LinkPreview,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof LinkPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    href: 'https://example.com',
    title: 'Example Website',
    description: 'A sample link preview',
  },
};

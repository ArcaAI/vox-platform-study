import type { Meta, StoryObj } from '@storybook/react-vite';

import { Video } from '../../../registries/tool-ui/video';

const meta = {
  title: 'Registries/ToolUI/Video',
  component: Video,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Video>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    assetId: 'asset-1',
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    title: 'Sample Video',
  },
};

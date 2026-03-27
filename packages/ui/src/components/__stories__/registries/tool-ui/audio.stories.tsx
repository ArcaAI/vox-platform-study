import type { Meta, StoryObj } from '@storybook/react-vite';

import { Audio } from '../../../registries/tool-ui/audio';

const meta = {
  title: 'Registries/ToolUI/Audio',
  component: Audio,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Audio>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    assetId: 'asset-1',
    src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    title: 'Sample Audio',
  },
};

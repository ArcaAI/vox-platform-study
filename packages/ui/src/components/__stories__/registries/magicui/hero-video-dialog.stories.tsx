import type { Meta, StoryObj } from '@storybook/react-vite';

import { HeroVideoDialog } from '../../../registries/magicui/hero-video-dialog';

const meta = {
  title: 'Registries/MagicUI/HeroVideoDialog',
  component: HeroVideoDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof HeroVideoDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    videoSrc: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    thumbnailSrc: 'https://via.placeholder.com/600x400',
    thumbnailAlt: 'Video thumbnail',
    animationStyle: 'from-center',
  },
};

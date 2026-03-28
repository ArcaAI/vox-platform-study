import type { Meta, StoryObj } from '@storybook/react-vite';

import { ImageGallery } from '../../../registries/tool-ui/image-gallery';

const meta = {
  title: 'Registries/ToolUI/ImageGallery',
  component: ImageGallery,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ImageGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    images: [
      {
        id: 'img1',
        src: 'https://picsum.photos/400/300',
        alt: 'Sample 1',
        width: 400,
        height: 300,
      },
      {
        id: 'img2',
        src: 'https://picsum.photos/400/301',
        alt: 'Sample 2',
        width: 400,
        height: 300,
      },
    ],
  },
};

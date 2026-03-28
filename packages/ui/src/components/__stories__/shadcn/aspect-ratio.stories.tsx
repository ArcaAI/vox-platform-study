import type { Meta, StoryObj } from '@storybook/react-vite';

import { AspectRatio } from '../../shadcn/aspect-ratio';

const meta = {
  title: 'Components/AspectRatio',
  component: AspectRatio,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof AspectRatio>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default 16:9 ratio
export const Default: Story = {
  render: () => (
    <div className="w-[450px]">
      <AspectRatio ratio={16 / 9}>
        <div className="bg-muted flex h-full w-full items-center justify-center rounded-md">
          <span className="text-muted-foreground text-sm">16 : 9</span>
        </div>
      </AspectRatio>
    </div>
  ),
};

// Square 1:1 ratio
export const Square: Story = {
  render: () => (
    <div className="w-[300px]">
      <AspectRatio ratio={1}>
        <div className="bg-muted flex h-full w-full items-center justify-center rounded-md">
          <span className="text-muted-foreground text-sm">1 : 1</span>
        </div>
      </AspectRatio>
    </div>
  ),
};

// Multiple ratios side by side
export const Ratios: Story = {
  render: () => (
    <div className="flex w-[700px] items-start gap-4">
      <div className="flex-1">
        <p className="text-muted-foreground mb-2 text-center text-sm">16 : 9</p>
        <AspectRatio ratio={16 / 9}>
          <div className="bg-muted flex h-full w-full items-center justify-center rounded-md">
            <span className="text-muted-foreground text-sm">16 : 9</span>
          </div>
        </AspectRatio>
      </div>
      <div className="flex-1">
        <p className="text-muted-foreground mb-2 text-center text-sm">4 : 3</p>
        <AspectRatio ratio={4 / 3}>
          <div className="bg-muted flex h-full w-full items-center justify-center rounded-md">
            <span className="text-muted-foreground text-sm">4 : 3</span>
          </div>
        </AspectRatio>
      </div>
      <div className="flex-1">
        <p className="text-muted-foreground mb-2 text-center text-sm">1 : 1</p>
        <AspectRatio ratio={1}>
          <div className="bg-muted flex h-full w-full items-center justify-center rounded-md">
            <span className="text-muted-foreground text-sm">1 : 1</span>
          </div>
        </AspectRatio>
      </div>
    </div>
  ),
};

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Marquee, MarqueeContent, MarqueeFade, MarqueeItem } from '../../../registries/kibo-ui/marquee';

const meta = {
  title: 'Registries/KiboUI/Marquee',
  component: Marquee,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof Marquee>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Marquee>
      <MarqueeFade side="left" />
      <MarqueeContent>
        <MarqueeItem>Item 1</MarqueeItem>
        <MarqueeItem>Item 2</MarqueeItem>
        <MarqueeItem>Item 3</MarqueeItem>
        <MarqueeItem>Item 4</MarqueeItem>
        <MarqueeItem>Item 5</MarqueeItem>
      </MarqueeContent>
      <MarqueeFade side="right" />
    </Marquee>
  ),
};

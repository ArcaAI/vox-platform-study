import type { Meta, StoryObj } from '@storybook/react-vite';

import { Marquee } from '../../../registries/magicui/marquee';

const meta: Meta = {
  title: 'Registries/MagicUI/Marquee',
  component: Marquee,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Marquee>
      <div className="rounded-lg border bg-muted px-4 py-2">Item 1</div>
      <div className="rounded-lg border bg-muted px-4 py-2">Item 2</div>
      <div className="rounded-lg border bg-muted px-4 py-2">Item 3</div>
      <div className="rounded-lg border bg-muted px-4 py-2">Item 4</div>
      <div className="rounded-lg border bg-muted px-4 py-2">Item 5</div>
    </Marquee>
  ),
};

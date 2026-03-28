import type { Meta, StoryObj } from '@storybook/react-vite';

import { cn } from '@/lib/utils';

import { BentoCard, BentoGrid } from '../../../registries/magicui/bento-grid';

const meta: Meta = {
  title: 'Registries/MagicUI/BentoGrid',
  component: BentoGrid,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

const IconPlaceholder = ({ className }: { className?: string }) => <div className={cn('h-12 w-12 rounded bg-muted', className)} />;

export const Default: Story = {
  render: () => (
    <BentoGrid className="max-w-4xl mx-auto p-4">
      <BentoCard
        name="Card One"
        description="First bento card with placeholder content."
        className="col-span-3"
        Icon={IconPlaceholder}
        href="#"
        cta="Learn more"
        background={<div className="absolute inset-0 bg-muted/50" />}
      />
      <BentoCard
        name="Card Two"
        description="Second bento card with more content."
        className="col-span-3"
        Icon={IconPlaceholder}
        href="#"
        cta="Explore"
        background={<div className="absolute inset-0 bg-muted/30" />}
      />
      <BentoCard
        name="Card Three"
        description="Third bento card for the grid."
        className="col-span-3"
        Icon={IconPlaceholder}
        href="#"
        cta="View"
        background={<div className="absolute inset-0 bg-muted/40" />}
      />
    </BentoGrid>
  ),
};

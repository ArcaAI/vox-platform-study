import { useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { AnimatedBeam } from '../../../registries/magicui/animated-beam';

function AnimatedBeamDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} className="relative flex h-48 w-96 items-center justify-center rounded-xl border bg-background">
      <div ref={fromRef} className="absolute left-8 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-primary" />
      <div ref={toRef} className="absolute right-8 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-primary" />
      <AnimatedBeam containerRef={containerRef} fromRef={fromRef} toRef={toRef} />
    </div>
  );
}

const meta: Meta = {
  title: 'Registries/MagicUI/AnimatedBeam',
  component: AnimatedBeam,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <AnimatedBeamDemo />,
};

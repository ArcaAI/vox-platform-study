import type { Meta, StoryObj } from '@storybook/react-vite';

import { Hero } from '../../../registries/manifest/hero';

const meta = {
  title: 'Registries/Manifest/Hero',
  component: Hero,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof Hero>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Hero />,
};

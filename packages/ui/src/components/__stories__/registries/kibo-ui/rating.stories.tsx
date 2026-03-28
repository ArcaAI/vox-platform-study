import type { Meta, StoryObj } from '@storybook/react-vite';

import { Rating, RatingButton } from '../../../registries/kibo-ui/rating';

const meta = {
  title: 'Registries/KiboUI/Rating',
  component: Rating,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Rating>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Rating defaultValue={3}>
      <RatingButton />
      <RatingButton />
      <RatingButton />
      <RatingButton />
      <RatingButton />
    </Rating>
  ),
};

export const ReadOnly: Story = {
  render: () => (
    <Rating defaultValue={4} readOnly>
      <RatingButton />
      <RatingButton />
      <RatingButton />
      <RatingButton />
      <RatingButton />
    </Rating>
  ),
};

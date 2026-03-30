import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProductList } from '../../../registries/manifest/product-list';

const meta = {
  title: 'Registries/Manifest/ProductList',
  component: ProductList,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ProductList />,
};

export const Grid: Story = {
  render: () => <ProductList appearance={{ variant: 'grid' }} />,
};

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tags, TagsTrigger, TagsValue, TagsContent, TagsInput, TagsList, TagsEmpty, TagsGroup, TagsItem } from '../../../registries/kibo-ui/tags';

const meta = {
  title: 'Registries/KiboUI/Tags',
  component: Tags,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tags>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tags className="w-80">
      <TagsTrigger>
        <TagsValue>React</TagsValue>
        <TagsValue>TypeScript</TagsValue>
      </TagsTrigger>
      <TagsContent>
        <TagsInput placeholder="Search tags..." />
        <TagsList>
          <TagsEmpty />
          <TagsGroup>
            <TagsItem value="react">React</TagsItem>
            <TagsItem value="typescript">TypeScript</TagsItem>
            <TagsItem value="tailwind">Tailwind CSS</TagsItem>
          </TagsGroup>
        </TagsList>
      </TagsContent>
    </Tags>
  ),
};

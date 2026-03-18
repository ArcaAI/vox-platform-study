import type { Meta, StoryObj } from '@storybook/react-vite'

import { Announcement, AnnouncementTag, AnnouncementTitle } from '../../../registries/kibo-ui/announcement'

const meta = {
  title: 'Registries/KiboUI/Announcement',
  component: Announcement,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Announcement>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Announcement>
      <AnnouncementTag>New</AnnouncementTag>
      <AnnouncementTitle>Introducing our latest feature</AnnouncementTitle>
    </Announcement>
  ),
}

export const Themed: Story = {
  render: () => (
    <Announcement themed>
      <AnnouncementTag>Update</AnnouncementTag>
      <AnnouncementTitle>Version 2.0 is here</AnnouncementTitle>
    </Announcement>
  ),
}

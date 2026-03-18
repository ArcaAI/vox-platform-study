import type { Meta, StoryObj } from '@storybook/react-vite'
import { InfoIcon } from 'lucide-react'

import { Banner, BannerIcon, BannerTitle, BannerAction, BannerClose } from '../../../registries/kibo-ui/banner'

const meta = {
  title: 'Registries/KiboUI/Banner',
  component: Banner,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Banner>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Banner>
      <BannerIcon icon={InfoIcon} />
      <BannerTitle>This is an important announcement</BannerTitle>
      <BannerAction>Learn more</BannerAction>
      <BannerClose />
    </Banner>
  ),
}

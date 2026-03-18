import type { Meta, StoryObj } from '@storybook/react-vite'

import { ContactForm } from '../../../registries/manifest/contact-form'

const meta = {
  title: 'Registries/Manifest/ContactForm',
  component: ContactForm,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ContactForm>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <ContactForm />,
}

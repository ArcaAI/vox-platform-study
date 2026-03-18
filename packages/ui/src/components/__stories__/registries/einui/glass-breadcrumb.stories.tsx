import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  GlassBreadcrumb,
  GlassBreadcrumbList,
  GlassBreadcrumbItem,
  GlassBreadcrumbLink,
  GlassBreadcrumbPage,
  GlassBreadcrumbSeparator,
} from '@/components/registries/einui/glass-breadcrumb'

function GlassBreadcrumbDemo() {
  return (
    <GlassBreadcrumb>
      <GlassBreadcrumbList>
        <GlassBreadcrumbItem>
          <GlassBreadcrumbLink href="/">Home</GlassBreadcrumbLink>
        </GlassBreadcrumbItem>
        <GlassBreadcrumbSeparator />
        <GlassBreadcrumbItem>
          <GlassBreadcrumbLink href="/products">Products</GlassBreadcrumbLink>
        </GlassBreadcrumbItem>
        <GlassBreadcrumbSeparator />
        <GlassBreadcrumbItem>
          <GlassBreadcrumbPage>Current Page</GlassBreadcrumbPage>
        </GlassBreadcrumbItem>
      </GlassBreadcrumbList>
    </GlassBreadcrumb>
  )
}

const meta = {
  title: 'Registries/EinUI/GlassBreadcrumb',
  component: GlassBreadcrumbDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassBreadcrumbDemo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <GlassBreadcrumbDemo />,
}

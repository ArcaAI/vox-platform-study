import type { Meta, StoryObj } from '@storybook/react-vite'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../shadcn/tabs'
import { Input } from '../../shadcn/input'
import { Label } from '../../shadcn/label'
import { Button } from '../../shadcn/button'

const meta = {
  title: 'Components/Tabs',
  component: Tabs,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="account" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
      </TabsList>
      <TabsContent value="account">
        <div className="space-y-4 pt-4">
          <div className="space-y-1">
            <Label htmlFor="name">Name</Label>
            <Input id="name" defaultValue="Pedro Duarte" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="username">Username</Label>
            <Input id="username" defaultValue="@peduarte" />
          </div>
          <Button>Save changes</Button>
        </div>
      </TabsContent>
      <TabsContent value="password">
        <div className="space-y-4 pt-4">
          <div className="space-y-1">
            <Label htmlFor="current">Current password</Label>
            <Input id="current" type="password" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new">New password</Label>
            <Input id="new" type="password" />
          </div>
          <Button>Change password</Button>
        </div>
      </TabsContent>
    </Tabs>
  ),
}

export const LineVariant: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-[400px]">
      <TabsList variant="line">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
        <TabsTrigger value="reports">Reports</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="pt-4">
        <p className="text-muted-foreground text-sm">Overview content goes here.</p>
      </TabsContent>
      <TabsContent value="analytics" className="pt-4">
        <p className="text-muted-foreground text-sm">Analytics content goes here.</p>
      </TabsContent>
      <TabsContent value="reports" className="pt-4">
        <p className="text-muted-foreground text-sm">Reports content goes here.</p>
      </TabsContent>
    </Tabs>
  ),
}

export const Vertical: Story = {
  render: () => (
    <Tabs defaultValue="general" orientation="vertical" className="flex w-[500px] gap-4">
      <TabsList className="flex-col">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="notifications">Notifications</TabsTrigger>
      </TabsList>
      <div className="flex-1">
        <TabsContent value="general">
          <p className="text-muted-foreground text-sm">General settings content.</p>
        </TabsContent>
        <TabsContent value="security">
          <p className="text-muted-foreground text-sm">Security settings content.</p>
        </TabsContent>
        <TabsContent value="notifications">
          <p className="text-muted-foreground text-sm">Notification preferences.</p>
        </TabsContent>
      </div>
    </Tabs>
  ),
}

export const Disabled: Story = {
  render: () => (
    <Tabs defaultValue="active" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="disabled" disabled>
          Disabled
        </TabsTrigger>
        <TabsTrigger value="other">Other</TabsTrigger>
      </TabsList>
      <TabsContent value="active" className="pt-4">
        <p className="text-muted-foreground text-sm">Active tab content.</p>
      </TabsContent>
      <TabsContent value="other" className="pt-4">
        <p className="text-muted-foreground text-sm">Other tab content.</p>
      </TabsContent>
    </Tabs>
  ),
}

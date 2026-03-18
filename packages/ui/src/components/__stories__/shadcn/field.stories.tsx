import type { Meta, StoryObj } from '@storybook/react-vite'

import { Input } from '../../shadcn/input'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '../../shadcn/field'

const meta = {
  title: 'Components/Field',
  component: Field,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Field>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-[350px]">
      <Field orientation="vertical">
        <FieldLabel htmlFor="default-name">Full Name</FieldLabel>
        <FieldContent>
          <Input id="default-name" placeholder="Enter your full name" />
          <FieldDescription>Your name as it appears on your ID.</FieldDescription>
        </FieldContent>
      </Field>
    </div>
  ),
}

export const Horizontal: Story = {
  render: () => (
    <div className="w-[450px]">
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="h-name" className="w-24">
            Name
          </FieldLabel>
          <FieldContent>
            <Input id="h-name" placeholder="Enter your name" />
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="h-email" className="w-24">
            Email
          </FieldLabel>
          <FieldContent>
            <Input id="h-email" type="email" placeholder="Enter your email" />
          </FieldContent>
        </Field>
      </FieldGroup>
    </div>
  ),
}

export const WithError: Story = {
  render: () => (
    <div className="w-[350px]">
      <Field orientation="vertical" data-invalid="true">
        <FieldLabel htmlFor="error-email">Email</FieldLabel>
        <FieldContent>
          <Input id="error-email" type="email" defaultValue="invalid-email" aria-invalid="true" />
          <FieldDescription>We'll never share your email with anyone.</FieldDescription>
          <FieldError>Please enter a valid email address.</FieldError>
        </FieldContent>
      </Field>
    </div>
  ),
}

export const FieldSetExample: Story = {
  render: () => (
    <div className="w-[450px]">
      <FieldSet>
        <FieldLegend>Personal Information</FieldLegend>
        <FieldDescription>Fill in your personal details below.</FieldDescription>
        <FieldGroup>
          <Field orientation="vertical">
            <FieldLabel htmlFor="fs-first">First Name</FieldLabel>
            <FieldContent>
              <Input id="fs-first" placeholder="First name" />
            </FieldContent>
          </Field>
          <Field orientation="vertical">
            <FieldLabel htmlFor="fs-last">Last Name</FieldLabel>
            <FieldContent>
              <Input id="fs-last" placeholder="Last name" />
            </FieldContent>
          </Field>
          <FieldSeparator />
          <Field orientation="vertical">
            <FieldLabel htmlFor="fs-email">Email</FieldLabel>
            <FieldContent>
              <Input id="fs-email" type="email" placeholder="Email address" />
              <FieldDescription>Your primary contact email.</FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
      </FieldSet>
    </div>
  ),
}

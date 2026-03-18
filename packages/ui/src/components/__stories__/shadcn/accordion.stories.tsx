import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '../../shadcn/accordion'

const meta = {
  title: 'Components/Accordion',
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Accordion>

export default meta
type Story = StoryObj<typeof meta>

// Default single accordion
export const Default: Story = {
  render: () => (
    <Accordion type="single" collapsible className="w-100">
      <AccordionItem value="item-1">
        <AccordionTrigger>Is it accessible?</AccordionTrigger>
        <AccordionContent>
          Yes. It adheres to the WAI-ARIA design pattern.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Is it styled?</AccordionTrigger>
        <AccordionContent>
          Yes. It comes with default styles that match the other components.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>Is it animated?</AccordionTrigger>
        <AccordionContent>
          Yes. It's animated by default, but you can disable it if you prefer.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}

// Multiple items can be open simultaneously
export const Multiple: Story = {
  render: () => (
    <Accordion type="multiple" className="w-100">
      <AccordionItem value="item-1">
        <AccordionTrigger>Section One</AccordionTrigger>
        <AccordionContent>
          This section can be open at the same time as other sections.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Section Two</AccordionTrigger>
        <AccordionContent>
          Try opening multiple sections at once.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>Section Three</AccordionTrigger>
        <AccordionContent>
          All three sections can be expanded simultaneously.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}

// Items with rich content
export const WithContent: Story = {
  render: () => (
    <Accordion type="single" collapsible className="w-100">
      <AccordionItem value="item-1">
        <AccordionTrigger>Getting Started</AccordionTrigger>
        <AccordionContent>
          <p className="mb-2">
            Follow these steps to get started with the project:
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>Clone the repository</li>
            <li>Install dependencies</li>
            <li>Run the development server</li>
          </ul>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Configuration</AccordionTrigger>
        <AccordionContent>
          <p className="mb-2">
            The project can be configured through environment variables and
            config files. Below are the key settings:
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <strong>API_URL</strong> — Base URL for the API
            </li>
            <li>
              <strong>DEBUG</strong> — Enable debug mode
            </li>
            <li>
              <strong>PORT</strong> — Server port number
            </li>
          </ul>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>FAQ</AccordionTrigger>
        <AccordionContent>
          <div className="space-y-3">
            <p>
              <strong>Q: Can I use this in production?</strong>
              <br />
              A: Yes, it is production-ready and fully tested.
            </p>
            <p>
              <strong>Q: Is TypeScript supported?</strong>
              <br />
              A: Yes, the project is written entirely in TypeScript with full
              type safety.
            </p>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}

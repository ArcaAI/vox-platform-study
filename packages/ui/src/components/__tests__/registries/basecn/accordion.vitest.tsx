import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '../../../registries/basecn/accordion'

describe('Accordion', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Accordion>
        <AccordionItem value="item-1">
          <AccordionTrigger>Question</AccordionTrigger>
          <AccordionContent>Answer</AccordionContent>
        </AccordionItem>
      </Accordion>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

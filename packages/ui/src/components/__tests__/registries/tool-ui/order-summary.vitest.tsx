import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { OrderSummary } from '../../../registries/tool-ui/order-summary'

describe('OrderSummary', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <OrderSummary id="1" items={[{ id: "1", name: "Widget", quantity: 1, unitPrice: 9.99 }]} pricing={{ subtotal: 9.99, total: 9.99 }} />
    )
    expect(container.firstChild).toBeTruthy()
  })
})

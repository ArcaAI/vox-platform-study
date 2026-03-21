import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DataTable } from '../../../registries/tool-ui/data-table'

describe('DataTable', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <DataTable id="1" columns={[{ key: "name", label: "Name" }]} data={[{ name: "Alice" }]} />
    )
    expect(container.firstChild).toBeTruthy()
  })
})

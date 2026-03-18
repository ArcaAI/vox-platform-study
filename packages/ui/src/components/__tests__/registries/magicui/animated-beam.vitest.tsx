import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { AnimatedBeam } from '../../../registries/magicui/animated-beam'

function TestWrapper() {
  const containerRef = useRef<HTMLDivElement>(null)
  const fromRef = useRef<HTMLDivElement>(null)
  const toRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={containerRef}>
      <div ref={fromRef}>From</div>
      <div ref={toRef}>To</div>
      <AnimatedBeam containerRef={containerRef} fromRef={fromRef} toRef={toRef} />
    </div>
  )
}

describe('AnimatedBeam', () => {
  it('renders without crashing', () => {
    const { container } = render(<TestWrapper />)
    expect(container.firstChild).toBeTruthy()
  })
})

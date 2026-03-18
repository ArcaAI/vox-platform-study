import { describe, it, expect } from 'vitest'
import { nodes } from '../../../registries/shadcn-editor/nodes'

describe('nodes', () => {
  it('exports a non-empty array of nodes', () => {
    expect(Array.isArray(nodes)).toBe(true)
    expect(nodes.length).toBeGreaterThan(0)
  })

  it('contains HeadingNode', () => {
    const names = nodes.map((n) => (typeof n === 'function' ? n.name : ''))
    expect(names).toContain('HeadingNode')
  })

  it('contains ParagraphNode', () => {
    const names = nodes.map((n) => (typeof n === 'function' ? n.name : ''))
    expect(names).toContain('ParagraphNode')
  })

  it('contains TextNode', () => {
    const names = nodes.map((n) => (typeof n === 'function' ? n.name : ''))
    expect(names).toContain('TextNode')
  })

  it('contains QuoteNode', () => {
    const names = nodes.map((n) => (typeof n === 'function' ? n.name : ''))
    expect(names).toContain('QuoteNode')
  })
})

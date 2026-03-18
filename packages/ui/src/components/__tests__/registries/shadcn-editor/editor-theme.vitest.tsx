import { describe, it, expect } from 'vitest'
import { editorTheme } from '../../../registries/shadcn-editor/themes/editor-theme'

describe('editorTheme', () => {
  it('exports a valid theme object', () => {
    expect(editorTheme).toBeDefined()
    expect(typeof editorTheme).toBe('object')
  })

  it('contains heading classes', () => {
    expect(editorTheme.heading).toBeDefined()
    expect(editorTheme.heading?.h1).toBeTruthy()
    expect(editorTheme.heading?.h2).toBeTruthy()
    expect(editorTheme.heading?.h3).toBeTruthy()
  })

  it('contains paragraph class', () => {
    expect(editorTheme.paragraph).toBeTruthy()
  })

  it('contains text formatting classes', () => {
    expect(editorTheme.text).toBeDefined()
    expect(editorTheme.text?.bold).toBeTruthy()
    expect(editorTheme.text?.italic).toBeTruthy()
    expect(editorTheme.text?.underline).toBeTruthy()
    expect(editorTheme.text?.strikethrough).toBeTruthy()
  })

  it('contains quote class', () => {
    expect(editorTheme.quote).toBeTruthy()
  })

  it('contains list classes', () => {
    expect(editorTheme.list).toBeDefined()
    expect(editorTheme.list?.ol).toBeTruthy()
    expect(editorTheme.list?.ul).toBeTruthy()
  })

  it('contains ltr and rtl classes', () => {
    expect(editorTheme.ltr).toBe('text-left')
    expect(editorTheme.rtl).toBe('text-right')
  })
})

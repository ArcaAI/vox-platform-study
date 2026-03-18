import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Tree, Folder, File } from '../../../registries/magicui/file-tree'

describe('FileTree', () => {
  it('renders without crashing', () => {
    const elements = [
      {
        id: "1",
        name: "src",
        children: [{ id: "2", name: "index.ts" }],
      },
    ]

    const { container } = render(
      <Tree
        elements={elements}
        initialExpandedItems={["1"]}
      >
        <Folder element="src" value="1">
          <File value="2">
            <span>index.ts</span>
          </File>
        </Folder>
      </Tree>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

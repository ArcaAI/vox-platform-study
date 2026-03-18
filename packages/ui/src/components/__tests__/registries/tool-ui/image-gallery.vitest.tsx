import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ImageGallery } from '../../../registries/tool-ui/image-gallery'

describe('ImageGallery', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ImageGallery id="1" images={[{ id: "1", src: "https://picsum.photos/200", alt: "Test", width: 200, height: 200 }]} />
    )
    expect(container.firstChild).toBeTruthy()
  })
})

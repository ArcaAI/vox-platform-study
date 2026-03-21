import { test, expect } from '@playwright/experimental-ct-react'
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
} from '../../shadcn/avatar'

test.describe('Avatar', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveAttribute('data-slot', 'avatar')
    })

    test('renders with default size', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveAttribute('data-size', 'default')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Avatar className="custom-avatar">
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveClass(/custom-avatar/)
    })

    test('has rounded-full styling', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveClass(/rounded-full/)
    })

    test('has overflow-hidden styling', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveClass(/overflow-hidden/)
    })
  })

  test.describe('sizes', () => {
    test('renders default size with size-8', async ({ mount }) => {
      const component = await mount(
        <Avatar size="default">
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveAttribute('data-size', 'default')
      await expect(component).toHaveClass(/size-8/)
    })

    test('renders sm size with data-size attribute', async ({ mount }) => {
      const component = await mount(
        <Avatar size="sm">
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveAttribute('data-size', 'sm')
    })

    test('sm size has size-6 class via data attribute', async ({ mount }) => {
      const component = await mount(
        <Avatar size="sm">
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveClass(/data-\[size=sm\]:size-6/)
    })

    test('renders lg size with data-size attribute', async ({ mount }) => {
      const component = await mount(
        <Avatar size="lg">
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveAttribute('data-size', 'lg')
    })

    test('lg size has size-10 class via data attribute', async ({ mount }) => {
      const component = await mount(
        <Avatar size="lg">
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveClass(/data-\[size=lg\]:size-10/)
    })
  })

  test.describe('AvatarImage', () => {
    test('renders image with data-slot', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarImage
            src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"
            alt="User avatar"
          />
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      const image = component.locator('[data-slot="avatar-image"]')
      await expect(image).toHaveAttribute('data-slot', 'avatar-image')
    })

    test('image has alt text', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarImage
            src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"
            alt="User avatar"
          />
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      const image = component.locator('[data-slot="avatar-image"]')
      await expect(image).toHaveAttribute('alt', 'User avatar')
    })

    test('applies custom className to image', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarImage
            src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"
            alt="avatar"
            className="custom-image"
          />
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      const image = component.locator('[data-slot="avatar-image"]')
      await expect(image).toHaveClass(/custom-image/)
    })
  })

  test.describe('AvatarFallback', () => {
    test('renders fallback with data-slot', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      const fallback = component.locator('[data-slot="avatar-fallback"]')
      await expect(fallback).toBeVisible()
      await expect(fallback).toHaveText('AB')
    })

    test('displays fallback when image fails to load', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarImage src="https://broken-image-url.invalid/img.png" alt="broken" />
          <AvatarFallback>FB</AvatarFallback>
        </Avatar>
      )
      const fallback = component.locator('[data-slot="avatar-fallback"]')
      await expect(fallback).toBeVisible()
      await expect(fallback).toHaveText('FB')
    })

    test('applies custom className to fallback', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback className="custom-fallback">AB</AvatarFallback>
        </Avatar>
      )
      const fallback = component.locator('[data-slot="avatar-fallback"]')
      await expect(fallback).toHaveClass(/custom-fallback/)
    })

    test('fallback has centered flex layout', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      const fallback = component.locator('[data-slot="avatar-fallback"]')
      await expect(fallback).toHaveClass(/flex/)
      await expect(fallback).toHaveClass(/items-center/)
      await expect(fallback).toHaveClass(/justify-center/)
    })

    test('fallback has muted background', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
        </Avatar>
      )
      const fallback = component.locator('[data-slot="avatar-fallback"]')
      await expect(fallback).toHaveClass(/bg-muted/)
    })
  })

  test.describe('AvatarBadge', () => {
    test('renders badge with data-slot', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
          <AvatarBadge />
        </Avatar>
      )
      const badge = component.locator('[data-slot="avatar-badge"]')
      await expect(badge).toBeVisible()
      await expect(badge).toHaveAttribute('data-slot', 'avatar-badge')
    })

    test('badge is positioned absolutely', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
          <AvatarBadge />
        </Avatar>
      )
      const badge = component.locator('[data-slot="avatar-badge"]')
      await expect(badge).toHaveClass(/absolute/)
      await expect(badge).toHaveClass(/right-0/)
      await expect(badge).toHaveClass(/bottom-0/)
    })

    test('applies custom className to badge', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
          <AvatarBadge className="custom-badge" />
        </Avatar>
      )
      const badge = component.locator('[data-slot="avatar-badge"]')
      await expect(badge).toHaveClass(/custom-badge/)
    })

    test('badge has ring styling', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>AB</AvatarFallback>
          <AvatarBadge />
        </Avatar>
      )
      const badge = component.locator('[data-slot="avatar-badge"]')
      await expect(badge).toHaveClass(/ring-2/)
    })
  })

  test.describe('AvatarGroup', () => {
    test('renders group with data-slot', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>B</AvatarFallback>
          </Avatar>
        </AvatarGroup>
      )
      await expect(component).toHaveAttribute('data-slot', 'avatar-group')
    })

    test('renders multiple avatars in group', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>B</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>C</AvatarFallback>
          </Avatar>
        </AvatarGroup>
      )
      const avatars = component.locator('[data-slot="avatar"]')
      await expect(avatars).toHaveCount(3)
    })

    test('group has negative spacing', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>B</AvatarFallback>
          </Avatar>
        </AvatarGroup>
      )
      await expect(component).toHaveClass(/-space-x-2/)
    })

    test('applies custom className to group', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup className="custom-group">
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
        </AvatarGroup>
      )
      await expect(component).toHaveClass(/custom-group/)
    })
  })

  test.describe('AvatarGroupCount', () => {
    test('renders group count with data-slot', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <AvatarGroupCount>+5</AvatarGroupCount>
        </AvatarGroup>
      )
      const count = component.locator('[data-slot="avatar-group-count"]')
      await expect(count).toBeVisible()
      await expect(count).toHaveText('+5')
    })

    test('group count has muted background', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <AvatarGroupCount>+3</AvatarGroupCount>
        </AvatarGroup>
      )
      const count = component.locator('[data-slot="avatar-group-count"]')
      await expect(count).toHaveClass(/bg-muted/)
    })

    test('group count has rounded-full styling', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <AvatarGroupCount>+3</AvatarGroupCount>
        </AvatarGroup>
      )
      const count = component.locator('[data-slot="avatar-group-count"]')
      await expect(count).toHaveClass(/rounded-full/)
    })

    test('applies custom className to group count', async ({ mount }) => {
      const component = await mount(
        <AvatarGroup>
          <AvatarGroupCount className="custom-count">+3</AvatarGroupCount>
        </AvatarGroup>
      )
      const count = component.locator('[data-slot="avatar-group-count"]')
      await expect(count).toHaveClass(/custom-count/)
    })
  })

  test.describe('composition', () => {
    test('renders full avatar group with count', async ({ mount, page }) => {
      await mount(
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>JD</AvatarFallback>
            <AvatarBadge />
          </Avatar>
          <Avatar>
            <AvatarFallback>SM</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>TK</AvatarFallback>
          </Avatar>
          <AvatarGroupCount>+4</AvatarGroupCount>
        </AvatarGroup>
      )

      await expect(page.locator('[data-slot="avatar-group"]')).toBeVisible()
      await expect(page.locator('[data-slot="avatar"]')).toHaveCount(3)
      await expect(
        page.locator('[data-slot="avatar-group-count"]')
      ).toHaveText('+4')
      await expect(page.locator('[data-slot="avatar-badge"]')).toBeVisible()
    })
  })

  test.describe('accessibility', () => {
    test('image has alt attribute for screen readers', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarImage
            src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"
            alt="John Doe"
          />
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      )
      const image = component.locator('[data-slot="avatar-image"]')
      await expect(image).toHaveAttribute('alt', 'John Doe')
    })

    test('fallback provides text alternative', async ({ mount }) => {
      const component = await mount(
        <Avatar>
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      )
      const fallback = component.locator('[data-slot="avatar-fallback"]')
      await expect(fallback).toHaveText('JD')
    })

    test('avatar supports aria-label', async ({ mount }) => {
      const component = await mount(
        <Avatar aria-label="User profile picture">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      )
      await expect(component).toHaveAttribute(
        'aria-label',
        'User profile picture'
      )
    })
  })
})

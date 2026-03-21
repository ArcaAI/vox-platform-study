import { test, expect } from '@playwright/experimental-ct-react'
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
} from '../../shadcn/field'

test.describe('Field', () => {
  test.describe('Field (root)', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<Field>Field content</Field>)
      await expect(component).toBeVisible()
      await expect(component).toHaveAttribute('data-slot', 'field')
    })

    test('has group role', async ({ mount }) => {
      const component = await mount(<Field>Content</Field>)
      await expect(component).toHaveRole('group')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Field className="custom-field">Content</Field>
      )
      await expect(component).toHaveClass(/custom-field/)
    })
  })

  test.describe('orientation variants', () => {
    test('defaults to vertical orientation', async ({ mount }) => {
      const component = await mount(<Field>Content</Field>)
      await expect(component).toHaveAttribute(
        'data-orientation',
        'vertical'
      )
      await expect(component).toHaveClass(/flex-col/)
    })

    test('renders horizontal orientation', async ({ mount }) => {
      const component = await mount(
        <Field orientation="horizontal">Content</Field>
      )
      await expect(component).toHaveAttribute(
        'data-orientation',
        'horizontal'
      )
      await expect(component).toHaveClass(/flex-row/)
      await expect(component).toHaveClass(/items-center/)
    })

    test('renders responsive orientation', async ({ mount }) => {
      const component = await mount(
        <Field orientation="responsive">Content</Field>
      )
      await expect(component).toHaveAttribute(
        'data-orientation',
        'responsive'
      )
    })
  })

  test.describe('FieldSet', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<FieldSet>Fieldset content</FieldSet>)
      await expect(component).toHaveAttribute('data-slot', 'field-set')
    })

    test('renders as fieldset element', async ({ mount }) => {
      const component = await mount(<FieldSet>Content</FieldSet>)
      const tagName = await component.evaluate((el) =>
        el.tagName.toLowerCase()
      )
      expect(tagName).toBe('fieldset')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldSet className="custom-fieldset">Content</FieldSet>
      )
      await expect(component).toHaveClass(/custom-fieldset/)
    })

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(<FieldSet>Content</FieldSet>)
      await expect(component).toHaveClass(/flex/)
      await expect(component).toHaveClass(/flex-col/)
    })
  })

  test.describe('FieldLegend', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<FieldLegend>Legend</FieldLegend>)
      await expect(component).toHaveAttribute('data-slot', 'field-legend')
    })

    test('defaults to legend variant', async ({ mount }) => {
      const component = await mount(<FieldLegend>Legend</FieldLegend>)
      await expect(component).toHaveAttribute('data-variant', 'legend')
    })

    test('renders label variant', async ({ mount }) => {
      const component = await mount(
        <FieldLegend variant="label">Label Legend</FieldLegend>
      )
      await expect(component).toHaveAttribute('data-variant', 'label')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldLegend className="custom-legend">Legend</FieldLegend>
      )
      await expect(component).toHaveClass(/custom-legend/)
    })
  })

  test.describe('FieldGroup', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<FieldGroup>Group content</FieldGroup>)
      await expect(component).toHaveAttribute('data-slot', 'field-group')
    })

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(<FieldGroup>Content</FieldGroup>)
      await expect(component).toHaveClass(/flex/)
      await expect(component).toHaveClass(/flex-col/)
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldGroup className="custom-group">Content</FieldGroup>
      )
      await expect(component).toHaveClass(/custom-group/)
    })
  })

  test.describe('FieldContent', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <FieldContent>Content area</FieldContent>
      )
      await expect(component).toHaveAttribute('data-slot', 'field-content')
    })

    test('has flex layout', async ({ mount }) => {
      const component = await mount(<FieldContent>Content</FieldContent>)
      await expect(component).toHaveClass(/flex/)
      await expect(component).toHaveClass(/flex-col/)
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldContent className="custom-content">Content</FieldContent>
      )
      await expect(component).toHaveClass(/custom-content/)
    })
  })

  test.describe('FieldLabel', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<FieldLabel>Label text</FieldLabel>)
      await expect(component).toHaveAttribute('data-slot', 'field-label')
    })

    test('renders text content', async ({ mount }) => {
      const component = await mount(<FieldLabel>Email address</FieldLabel>)
      await expect(component).toHaveText('Email address')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldLabel className="custom-label">Label</FieldLabel>
      )
      await expect(component).toHaveClass(/custom-label/)
    })
  })

  test.describe('FieldTitle', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<FieldTitle>Title text</FieldTitle>)
      await expect(component).toHaveAttribute('data-slot', 'field-label')
    })

    test('has correct font styling', async ({ mount }) => {
      const component = await mount(<FieldTitle>Title</FieldTitle>)
      await expect(component).toHaveClass(/font-medium/)
      await expect(component).toHaveClass(/text-sm/)
    })
  })

  test.describe('FieldDescription', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <FieldDescription>Help text</FieldDescription>
      )
      await expect(component).toHaveAttribute(
        'data-slot',
        'field-description'
      )
    })

    test('renders text content', async ({ mount }) => {
      const component = await mount(
        <FieldDescription>Enter your email address</FieldDescription>
      )
      await expect(component).toHaveText('Enter your email address')
    })

    test('has muted text styling', async ({ mount }) => {
      const component = await mount(
        <FieldDescription>Description</FieldDescription>
      )
      await expect(component).toHaveClass(/text-muted-foreground/)
      await expect(component).toHaveClass(/text-sm/)
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldDescription className="custom-desc">Desc</FieldDescription>
      )
      await expect(component).toHaveClass(/custom-desc/)
    })
  })

  test.describe('FieldError', () => {
    test('renders with data-slot attribute when errors exist', async ({
      mount,
    }) => {
      const component = await mount(
        <FieldError errors={[{ message: 'Required' }]} />
      )
      await expect(component).toHaveAttribute('data-slot', 'field-error')
    })

    test('renders single error message', async ({ mount }) => {
      const component = await mount(
        <FieldError errors={[{ message: 'This field is required' }]} />
      )
      await expect(component).toHaveText('This field is required')
    })

    test('renders multiple error messages as list', async ({ mount }) => {
      const component = await mount(
        <FieldError
          errors={[
            { message: 'Too short' },
            { message: 'Must contain a number' },
          ]}
        />
      )
      await expect(component).toContainText('Too short')
      await expect(component).toContainText('Must contain a number')
    })

    test('does not render when errors array is empty', async ({ mount }) => {
      const component = await mount(<FieldError errors={[]} />)
      await expect(component).not.toBeVisible()
    })

    test('has alert role', async ({ mount }) => {
      const component = await mount(
        <FieldError errors={[{ message: 'Error' }]} />
      )
      await expect(component).toHaveRole('alert')
    })

    test('has destructive text styling', async ({ mount }) => {
      const component = await mount(
        <FieldError errors={[{ message: 'Error' }]} />
      )
      await expect(component).toHaveClass(/text-destructive/)
    })

    test('renders children instead of errors when provided', async ({
      mount,
    }) => {
      const component = await mount(
        <FieldError>Custom error content</FieldError>
      )
      await expect(component).toHaveText('Custom error content')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <FieldError className="custom-error" errors={[{ message: 'Err' }]}>
          Error
        </FieldError>
      )
      await expect(component).toHaveClass(/custom-error/)
    })
  })

  test.describe('FieldSeparator', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(<FieldSeparator />)
      await expect(component).toHaveAttribute('data-slot', 'field-separator')
    })

    test('renders with content text', async ({ mount }) => {
      const component = await mount(<FieldSeparator>or</FieldSeparator>)
      const content = component.locator(
        '[data-slot="field-separator-content"]'
      )
      await expect(content).toBeVisible()
      await expect(content).toHaveText('or')
    })

    test('does not render content span when no children', async ({
      mount,
    }) => {
      const component = await mount(<FieldSeparator />)
      const content = component.locator(
        '[data-slot="field-separator-content"]'
      )
      await expect(content).not.toBeAttached()
    })
  })

  test.describe('full composition', () => {
    test('renders complete field structure', async ({ mount, page }) => {
      await mount(
        <FieldSet>
          <FieldLegend>Personal Information</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel>Full Name</FieldLabel>
              <FieldContent>
                <input type="text" placeholder="John Doe" />
                <FieldDescription>
                  Enter your legal full name
                </FieldDescription>
              </FieldContent>
            </Field>
            <FieldSeparator />
            <Field>
              <FieldLabel>Email</FieldLabel>
              <FieldContent>
                <input type="email" placeholder="you@example.com" />
                <FieldError errors={[{ message: 'Email is required' }]} />
              </FieldContent>
            </Field>
          </FieldGroup>
        </FieldSet>
      )

      await expect(page.locator('[data-slot="field-set"]')).toBeVisible()
      await expect(page.locator('[data-slot="field-legend"]')).toHaveText(
        'Personal Information'
      )
      await expect(page.locator('[data-slot="field-group"]')).toBeVisible()

      const fields = page.locator('[data-slot="field"]')
      expect(await fields.count()).toBe(2)

      await expect(
        page.locator('[data-slot="field-separator"]')
      ).toBeVisible()
      await expect(page.locator('[data-slot="field-error"]')).toHaveText(
        'Email is required'
      )
    })
  })

  test.describe('accessibility', () => {
    test('field has group role for assistive technologies', async ({
      mount,
    }) => {
      const component = await mount(
        <Field>
          <FieldLabel>Name</FieldLabel>
        </Field>
      )
      await expect(component).toHaveRole('group')
    })

    test('field error has alert role', async ({ mount }) => {
      const component = await mount(
        <FieldError errors={[{ message: 'Invalid' }]} />
      )
      await expect(component).toHaveRole('alert')
    })

    test('fieldset is a semantic fieldset element', async ({ mount }) => {
      const component = await mount(
        <FieldSet>
          <FieldLegend>Group</FieldLegend>
        </FieldSet>
      )
      const tagName = await component.evaluate((el) =>
        el.tagName.toLowerCase()
      )
      expect(tagName).toBe('fieldset')
    })
  })
})

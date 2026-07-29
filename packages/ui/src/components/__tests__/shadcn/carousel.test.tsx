import { test, expect } from '@playwright/experimental-ct-react';
import { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext } from '../../shadcn/carousel';

test.describe('Carousel', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attributes', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
            <CarouselItem>Slide 2</CarouselItem>
            <CarouselItem>Slide 3</CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>,
      );

      await expect(page.locator('[data-slot="carousel"]')).toBeVisible();
      await expect(page.locator('[data-slot="carousel-content"]')).toBeVisible();
      await expect(page.locator('[data-slot="carousel-item"]').first()).toBeVisible();
      await expect(page.locator('[data-slot="carousel-previous"]')).toBeVisible();
      await expect(page.locator('[data-slot="carousel-next"]')).toBeVisible();
    });

    test('renders all carousel items', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
            <CarouselItem>Slide 2</CarouselItem>
            <CarouselItem>Slide 3</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const items = page.locator('[data-slot="carousel-item"]');
      await expect(items).toHaveCount(3);
    });

    test('applies custom className to carousel', async ({ mount, page }) => {
      await mount(
        <Carousel className="custom-carousel">
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const carousel = page.locator('[data-slot="carousel"]');
      await expect(carousel).toHaveClass(/custom-carousel/);
    });

    test('applies custom className to carousel item', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem className="custom-item">Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const item = page.locator('[data-slot="carousel-item"]');
      await expect(item).toHaveClass(/custom-item/);
    });
  });

  test.describe('orientation', () => {
    test('defaults to horizontal orientation', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const content = page.locator('[data-slot="carousel-content"] > div');
      await expect(content).toHaveClass(/\-ml-4/);
    });

    test('supports vertical orientation', async ({ mount, page }) => {
      await mount(
        <Carousel orientation="vertical">
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const content = page.locator('[data-slot="carousel-content"] > div');
      await expect(content).toHaveClass(/flex-col/);
    });
  });

  test.describe('navigation buttons', () => {
    test('previous button is visible', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
            <CarouselItem>Slide 2</CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>,
      );

      const prevButton = page.locator('[data-slot="carousel-previous"]');
      await expect(prevButton).toBeVisible();
    });

    test('next button is visible', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
            <CarouselItem>Slide 2</CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>,
      );

      const nextButton = page.locator('[data-slot="carousel-next"]');
      await expect(nextButton).toBeVisible();
    });

    test('previous button has outline variant by default', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
        </Carousel>,
      );

      const prevButton = page.locator('[data-slot="carousel-previous"]');
      await expect(prevButton).toHaveAttribute('data-variant', 'outline');
    });

    test('next button has outline variant by default', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
          <CarouselNext />
        </Carousel>,
      );

      const nextButton = page.locator('[data-slot="carousel-next"]');
      await expect(nextButton).toHaveAttribute('data-variant', 'outline');
    });

    test('navigation buttons have icon size', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>,
      );

      const prevButton = page.locator('[data-slot="carousel-previous"]');
      const nextButton = page.locator('[data-slot="carousel-next"]');
      await expect(prevButton).toHaveAttribute('data-size', 'icon');
      await expect(nextButton).toHaveAttribute('data-size', 'icon');
    });
  });

  test.describe('accessibility', () => {
    test('carousel has region role', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const carousel = page.locator('[data-slot="carousel"]');
      await expect(carousel).toHaveAttribute('role', 'region');
    });

    test('carousel has aria-roledescription', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const carousel = page.locator('[data-slot="carousel"]');
      await expect(carousel).toHaveAttribute('aria-roledescription', 'carousel');
    });

    test('carousel items have group role', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const item = page.locator('[data-slot="carousel-item"]');
      await expect(item).toHaveAttribute('role', 'group');
    });

    test('carousel items have slide roledescription', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
        </Carousel>,
      );

      const item = page.locator('[data-slot="carousel-item"]');
      await expect(item).toHaveAttribute('aria-roledescription', 'slide');
    });

    test('previous button has accessible name', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
        </Carousel>,
      );

      const prevButton = page.locator('[data-slot="carousel-previous"]');
      await expect(prevButton).toHaveAccessibleName('Previous slide');
    });

    test('next button has accessible name', async ({ mount, page }) => {
      await mount(
        <Carousel>
          <CarouselContent>
            <CarouselItem>Slide 1</CarouselItem>
          </CarouselContent>
          <CarouselNext />
        </Carousel>,
      );

      const nextButton = page.locator('[data-slot="carousel-next"]');
      await expect(nextButton).toHaveAccessibleName('Next slide');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InfoIcon } from 'lucide-react';
import { Banner, BannerIcon, BannerTitle } from '../../../registries/kibo-ui/banner';

describe('Banner', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Banner>
        <BannerIcon icon={InfoIcon} />
        <BannerTitle>Test banner</BannerTitle>
      </Banner>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

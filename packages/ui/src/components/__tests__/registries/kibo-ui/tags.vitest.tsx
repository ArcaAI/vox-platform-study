import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Tags, TagsTrigger, TagsValue } from '../../../registries/kibo-ui/tags';

describe('Tags', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Tags>
        <TagsTrigger>
          <TagsValue>Test</TagsValue>
        </TagsTrigger>
      </Tags>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

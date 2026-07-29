import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../../../registries/basecn/card';

describe('Card', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders card title', () => {
    const { getByText } = render(
      <Card>
        <CardHeader>
          <CardTitle>My Card</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(getByText('My Card')).toBeTruthy();
  });
});

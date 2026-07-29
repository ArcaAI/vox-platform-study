import { render, screen } from '@testing-library/react';
import { DocsLayout } from '../docs-layout';

vi.mock('@arcaai/ui/separator', () => ({
  Separator: (props: any) => <hr data-testid="separator" {...props} />,
}));

vi.mock('../table-of-contents', () => ({
  TableOfContents: ({ sections }: any) => (
    <nav data-testid="toc">
      {sections.map((s: any) => (
        <a key={s.id} href={`#${s.id}`}>
          {s.title}
        </a>
      ))}
    </nav>
  ),
}));

vi.mock('../cta-card', () => ({
  CtaCard: ({ title }: any) => <div data-testid="cta-card">{title}</div>,
}));

const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'usage', title: 'Usage' },
];

const cta = {
  title: 'Try it',
  description: 'Test the playground',
  buttonLabel: 'Go',
  href: '/playground',
};

describe('DocsLayout', () => {
  it('should render the page title', () => {
    render(
      <DocsLayout title="Getting Started" description="Welcome to the docs.">
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.getByRole('heading', { name: 'Getting Started' })).toBeInTheDocument();
  });

  it('should render the description', () => {
    render(
      <DocsLayout title="Test" description="A test description.">
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.getByText('A test description.')).toBeInTheDocument();
  });

  it('should render children in the main content area', () => {
    render(
      <DocsLayout title="Test" description="Desc">
        <p>Hello world</p>
      </DocsLayout>,
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('should render an article element for the main content', () => {
    render(
      <DocsLayout title="Test" description="Desc">
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('should render the table of contents when sections are provided', () => {
    render(
      <DocsLayout title="Test" description="Desc" sections={sections}>
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.getByTestId('toc')).toBeInTheDocument();
  });

  it('should not render the right sidebar when no sections or cta', () => {
    render(
      <DocsLayout title="Test" description="Desc">
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.queryByTestId('toc')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('should render CTA card when cta prop is provided', () => {
    render(
      <DocsLayout title="Test" description="Desc" cta={cta}>
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.getByTestId('cta-card')).toBeInTheDocument();
  });

  it('should render both TOC and CTA in the right sidebar', () => {
    render(
      <DocsLayout title="Test" description="Desc" sections={sections} cta={cta}>
        <p>Content</p>
      </DocsLayout>,
    );
    const aside = screen.getByRole('complementary');
    expect(aside).toBeInTheDocument();
    expect(screen.getByTestId('toc')).toBeInTheDocument();
    expect(screen.getByTestId('cta-card')).toBeInTheDocument();
  });

  it('should render a separator between the header and content', () => {
    render(
      <DocsLayout title="Test" description="Desc">
        <p>Content</p>
      </DocsLayout>,
    );
    expect(screen.getByTestId('separator')).toBeInTheDocument();
  });
});

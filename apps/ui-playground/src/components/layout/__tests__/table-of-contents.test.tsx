import { render, screen } from '@testing-library/react';
import { TableOfContents, type TocSection } from '../table-of-contents';

let ioInstances: MockIO[];

class MockIO {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn().mockReturnValue([]);
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    ioInstances.push(this);
  }
  get root() {
    return null;
  }
  get rootMargin() {
    return '';
  }
  get thresholds() {
    return [0];
  }
}

beforeEach(() => {
  ioInstances = [];
  window.IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
});

const sections: TocSection[] = [
  { id: 'overview', title: 'Overview' },
  { id: 'installation', title: 'Installation' },
  { id: 'usage', title: 'Usage' },
];

const nestedSections: TocSection[] = [
  { id: 'overview', title: 'Overview', level: 2 },
  { id: 'sub-detail', title: 'Sub Detail', level: 3 },
  { id: 'usage', title: 'Usage', level: 2 },
  { id: 'advanced', title: 'Advanced', level: 3 },
];

describe('TableOfContents', () => {
  it('should render a heading', () => {
    render(<TableOfContents sections={sections} />);
    expect(screen.getByText('On This Page')).toBeInTheDocument();
  });

  it('should render anchor links for each section', () => {
    render(<TableOfContents sections={sections} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', '#overview');
    expect(links[1]).toHaveAttribute('href', '#installation');
    expect(links[2]).toHaveAttribute('href', '#usage');
  });

  it('should render section titles as link text', () => {
    render(<TableOfContents sections={sections} />);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });

  it('should render nothing when sections array is empty', () => {
    const { container } = render(<TableOfContents sections={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('should indent h3-level items', () => {
    render(<TableOfContents sections={nestedSections} />);
    const subDetail = screen.getByText('Sub Detail').closest('a');
    const overview = screen.getByText('Overview').closest('a');
    expect(subDetail?.className).toMatch(/pl-4/);
    expect(overview?.className).not.toMatch(/pl-4/);
  });

  it('should default level to 2 when not specified', () => {
    render(<TableOfContents sections={[{ id: 'test', title: 'Test' }]} />);
    const link = screen.getByText('Test').closest('a');
    expect(link?.className).not.toMatch(/pl-4/);
  });

  it('should set up IntersectionObserver on mount', () => {
    render(<TableOfContents sections={sections} />);
    expect(ioInstances).toHaveLength(1);
  });
});

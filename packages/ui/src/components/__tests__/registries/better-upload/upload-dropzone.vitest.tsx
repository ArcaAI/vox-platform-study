import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UploadDropzone } from '../../../../components/registries/better-upload';

function createMockControl(overrides = {}) {
  return {
    upload: vi.fn(),
    isPending: false,
    progresses: new Map(),
    isSuccess: false,
    isError: false,
    ...overrides,
  } as any;
}

describe('UploadDropzone', () => {
  it('renders the dropzone with default text', () => {
    render(<UploadDropzone control={createMockControl()} />);
    expect(screen.getByText('Drag and drop files here')).toBeInTheDocument();
  });

  it('renders custom string description', () => {
    render(<UploadDropzone control={createMockControl()} description="Upload your resume" />);
    expect(screen.getByText('Upload your resume')).toBeInTheDocument();
  });

  it('renders structured description', () => {
    render(<UploadDropzone control={createMockControl()} description={{ fileTypes: 'PDF, DOCX', maxFileSize: '5MB', maxFiles: 3 }} />);
    expect(screen.getByText(/PDF, DOCX/)).toBeInTheDocument();
    expect(screen.getByText(/5MB/)).toBeInTheDocument();
  });

  it('disables input when pending', () => {
    render(<UploadDropzone control={createMockControl({ isPending: true })} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeDisabled();
  });
});

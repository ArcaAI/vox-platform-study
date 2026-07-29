import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileUpload, FileUploadDropzone } from '../../../registries/prompt-kit/file-upload';

describe('FileUpload', () => {
  it('renders without crashing', () => {
    render(
      <FileUpload>
        <FileUploadDropzone>Drop files here</FileUploadDropzone>
      </FileUpload>,
    );
    expect(screen.getByText('Drop files here')).toBeInTheDocument();
  });
});

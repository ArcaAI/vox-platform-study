/**
 * ProviderConfigPanel — smoke tests (TASK-328 A7)
 *
 * Pins the tenant storage provider-config contract: the form seeds from the
 * existing tenant config, "Save provider settings" submits the edited values
 * through the upsert mutation, default-bucket assignments submit through the
 * defaults mutation, and a DEDICATED topology requires a credentials reference.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── toast spy ───────────────────────────────────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

// ── api mocks ───────────────────────────────────────────────────────
let configsData: any[] = [];
let configsLoading = false;
const upsertMutate = vi.fn();
vi.mock('../../api/storage-config', () => ({
  useTenantStorageConfigs: () => ({ data: configsData, isLoading: configsLoading }),
  useUpsertTenantStorageConfig: () => ({ mutate: upsertMutate, isPending: false }),
}));

let defaultsData: any = { audio: null, attachments: null, misc: null };
const setDefaultsMutate = vi.fn();
vi.mock('../../api/tenant-storage', () => ({
  useTenantBucketDefaults: () => ({ data: defaultsData, isLoading: false }),
  useSetTenantBucketDefaults: () => ({ mutate: setDefaultsMutate, isPending: false }),
}));

// ── @arcaai/ui primitive stubs ──────────────────────────────────────
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...rest }: any) => <label {...rest}>{children}</label> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (props: any) => <div data-testid="skeleton" {...props} /> }));
vi.mock('@arcaai/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, id }: any) => (
    <input type="checkbox" id={id} checked={!!checked} onChange={(e) => onCheckedChange(e.target.checked)} />
  ),
}));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, id }: any) => <div id={id}>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
}));

const { ProviderConfigPanel } = await import('../provider-config-panel');

const baseBuckets = [
  {
    id: 'b-audio',
    tenantId: 't1',
    name: 'hope-audio',
    slug: 'audio',
    bucketType: 'SYSTEM',
    pathPattern: '',
    isSystemBucket: true,
    createdAt: '',
    updatedAt: '',
  },
];

beforeEach(() => {
  configsData = [];
  configsLoading = false;
  defaultsData = { audio: null, attachments: null, misc: null };
  upsertMutate.mockReset();
  setDefaultsMutate.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('ProviderConfigPanel (TASK-328 A7)', () => {
  it('shows skeletons while the config is loading', () => {
    configsLoading = true;
    render(<ProviderConfigPanel tenantId="t1" buckets={baseBuckets as any} />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  it('seeds the form from the existing config and submits the upsert with edits', () => {
    configsData = [
      {
        id: 'cfg-1',
        tenantId: 't1',
        bucketId: null,
        provider: 'AWS_S3',
        topology: 'SHARED',
        endpoint: 'https://s3.amazonaws.com',
        region: 'us-east-1',
        forcePathStyle: false,
        createdAt: '',
        updatedAt: '',
      },
    ];
    render(<ProviderConfigPanel tenantId="t1" buckets={baseBuckets as any} />);

    // Seeded from config.
    expect((screen.getByLabelText('Endpoint') as HTMLInputElement).value).toBe('https://s3.amazonaws.com');

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save provider settings/i }));

    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'AWS_S3', endpoint: 'https://s3.amazonaws.com', region: 'eu-west-1' }),
      expect.any(Object),
    );
  });

  it('submits the default-bucket assignment seeded from the defaults query', () => {
    defaultsData = { audio: baseBuckets[0], attachments: null, misc: null };
    render(<ProviderConfigPanel tenantId="t1" buckets={baseBuckets as any} />);

    fireEvent.click(screen.getByRole('button', { name: /save default buckets/i }));

    expect(setDefaultsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ audioBucketId: 'b-audio', attachmentsBucketId: undefined, miscBucketId: undefined }),
      expect.any(Object),
    );
  });

  it('blocks a DEDICATED topology save without a credentials reference', () => {
    configsData = [
      { id: 'cfg-1', tenantId: 't1', bucketId: null, provider: 'MINIO', topology: 'DEDICATED', credentialsRef: null, createdAt: '', updatedAt: '' },
    ];
    render(<ProviderConfigPanel tenantId="t1" buckets={baseBuckets as any} />);

    fireEvent.click(screen.getByRole('button', { name: /save provider settings/i }));

    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/credentials reference is required/i));
  });
});

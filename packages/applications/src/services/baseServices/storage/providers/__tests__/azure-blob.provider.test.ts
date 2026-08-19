/**
 * AzureBlobProvider Unit Tests
 *
 * Strategy: mock `@azure/storage-blob` (external boundary). The mock exposes a
 * single shared service/container/blob client chain (via vi.hoisted) so tests
 * can drive return values and assert the exact SDK calls. The client chain is
 * re-wired in beforeEach so the global afterEach restoreAllMocks cannot strand
 * later tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { StorageProvider } from '@arcaai/types';

const h = vi.hoisted(() => {
  const blockBlob = {
    url: 'https://acct.blob.core.windows.net/c/b',
    uploadData: vi.fn(),
    downloadToBuffer: vi.fn(),
    download: vi.fn(),
    deleteIfExists: vi.fn(),
  };
  const byPage = vi.fn();
  const listBlobsFlat = vi.fn();
  const container = {
    getBlockBlobClient: vi.fn(),
    createIfNotExists: vi.fn(),
    deleteIfExists: vi.fn(),
    exists: vi.fn(),
    listBlobsFlat,
  };
  const service = {
    getContainerClient: vi.fn(),
    getProperties: vi.fn(),
  };
  return { blockBlob, byPage, listBlobsFlat, container, service };
});

vi.mock('@azure/storage-blob', () => {
  // Regular `function` (not arrow) so it is constructable via `new`; returns
  // the shared service client object.
  const BlobServiceClient = vi.fn(function () {
    return h.service;
  }) as unknown as { (): unknown; fromConnectionString: ReturnType<typeof vi.fn> };
  BlobServiceClient.fromConnectionString = vi.fn(() => h.service);

  const StorageSharedKeyCredential = vi.fn(function (this: Record<string, unknown>, accountName: string, accountKey: string) {
    this.accountName = accountName;
    this.accountKey = accountKey;
  });

  const BlobSASPermissions = { parse: vi.fn((p: string) => ({ permissionString: p })) };
  const generateBlobSASQueryParameters = vi.fn(() => ({ toString: () => 'sv=2025&sig=MOCKSIG' }));
  const SASProtocol = { Https: 'https', HttpsAndHttp: 'https,http' };

  return { BlobServiceClient, StorageSharedKeyCredential, BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol };
});

import { BlobServiceClient, StorageSharedKeyCredential, BlobSASPermissions, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { AzureBlobProvider } from '../azure-blob.provider';
import { StorageNotSupportedError } from '../IBlobStorageProvider';

function makeProvider(overrides: Record<string, unknown> = {}): AzureBlobProvider {
  return new AzureBlobProvider({ accountName: 'acct', accountKey: 'key123==', ...overrides });
}

describe('AzureBlobProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire the client chain (clearAllMocks/restoreAllMocks may strip impls).
    h.service.getContainerClient.mockReturnValue(h.container);
    h.service.getProperties.mockReset();
    h.container.getBlockBlobClient.mockReturnValue(h.blockBlob);
    h.container.listBlobsFlat.mockReturnValue({ byPage: h.byPage });
    h.container.createIfNotExists.mockReset();
    h.container.deleteIfExists.mockReset();
    h.container.exists.mockReset();
    h.blockBlob.uploadData.mockReset();
    h.blockBlob.downloadToBuffer.mockReset();
    h.blockBlob.download.mockReset();
    h.blockBlob.deleteIfExists.mockReset();
    h.byPage.mockReset();
    (BlobServiceClient as unknown as { fromConnectionString: ReturnType<typeof vi.fn> }).fromConnectionString.mockReturnValue(h.service);
  });

  describe('construction', () => {
    it('exposes AZURE_BLOB as the provider id', () => {
      expect(makeProvider().provider).toBe(StorageProvider.AZURE_BLOB);
    });

    it('builds a shared-key credential + service client from account name/key', () => {
      makeProvider();
      expect(StorageSharedKeyCredential).toHaveBeenCalledWith('acct', 'key123==');
      expect(BlobServiceClient).toHaveBeenCalled();
    });

    it('builds the client from a connection string when provided', () => {
      const connectionString = 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=key123==;EndpointSuffix=core.windows.net';
      new AzureBlobProvider({ accountName: '', connectionString });
      expect((BlobServiceClient as unknown as { fromConnectionString: ReturnType<typeof vi.fn> }).fromConnectionString).toHaveBeenCalledWith(
        connectionString,
      );
    });

    it('throws when neither connection string nor account key is supplied', () => {
      expect(() => new AzureBlobProvider({ accountName: 'acct' })).toThrow();
    });
  });

  describe('putObject', () => {
    it('uploads via uploadData with content type header and metadata', async () => {
      h.blockBlob.uploadData.mockResolvedValue({});
      const body = Buffer.from('hello');

      await makeProvider().putObject({
        bucket: 'c',
        key: 'b',
        body,
        contentType: 'text/plain',
        metadata: { owner: 'tenant-1' },
      });

      expect(h.service.getContainerClient).toHaveBeenCalledWith('c');
      expect(h.container.getBlockBlobClient).toHaveBeenCalledWith('b');
      expect(h.blockBlob.uploadData).toHaveBeenCalledWith(body, {
        blobHTTPHeaders: { blobContentType: 'text/plain' },
        metadata: { owner: 'tenant-1' },
      });
    });
  });

  describe('getObject', () => {
    it('returns a Buffer via downloadToBuffer', async () => {
      const buf = Buffer.from('bytes');
      h.blockBlob.downloadToBuffer.mockResolvedValue(buf);

      const result = await makeProvider().getObject({ bucket: 'c', key: 'b' });

      expect(result).toBe(buf);
      expect(h.container.getBlockBlobClient).toHaveBeenCalledWith('b');
    });
  });

  describe('getObjectStream', () => {
    it('returns the readableStreamBody from download()', async () => {
      const fakeStream = { pipe: vi.fn() };
      h.blockBlob.download.mockResolvedValue({ readableStreamBody: fakeStream });

      const stream = await makeProvider().getObjectStream({ bucket: 'c', key: 'b' });

      expect(stream).toBe(fakeStream);
    });

    it('throws when there is no readable stream body', async () => {
      h.blockBlob.download.mockResolvedValue({ readableStreamBody: undefined });
      await expect(makeProvider().getObjectStream({ bucket: 'c', key: 'b' })).rejects.toThrow();
    });
  });

  describe('deleteObject', () => {
    it('calls deleteIfExists on the block blob client', async () => {
      h.blockBlob.deleteIfExists.mockResolvedValue({ succeeded: true });
      await makeProvider().deleteObject({ bucket: 'c', key: 'b' });
      expect(h.blockBlob.deleteIfExists).toHaveBeenCalled();
    });
  });

  describe('listObjects', () => {
    it('paginates via listBlobsFlat().byPage() and normalizes the page', async () => {
      const lastModified = new Date('2026-01-01T00:00:00Z');
      h.byPage.mockReturnValue({
        next: vi.fn().mockResolvedValue({
          value: {
            segment: {
              blobItems: [
                { name: 'a.txt', properties: { contentLength: 10, lastModified } },
                { name: 'b.txt', properties: { contentLength: 20, lastModified } },
              ],
            },
            continuationToken: 'TOKEN-2',
          },
          done: false,
        }),
      });

      const page = await makeProvider().listObjects({ bucket: 'c', prefix: 'p/', continuationToken: 'TOKEN-1', maxKeys: 2 });

      expect(h.container.listBlobsFlat).toHaveBeenCalledWith({ prefix: 'p/' });
      expect(h.byPage).toHaveBeenCalledWith({ continuationToken: 'TOKEN-1', maxPageSize: 2 });
      expect(page.objects).toEqual([
        { key: 'a.txt', size: 10, lastModified },
        { key: 'b.txt', size: 20, lastModified },
      ]);
      expect(page.isTruncated).toBe(true);
      expect(page.nextContinuationToken).toBe('TOKEN-2');
    });

    it('returns an empty, non-truncated page when the segment is empty', async () => {
      h.byPage.mockReturnValue({
        next: vi.fn().mockResolvedValue({ value: { segment: { blobItems: [] }, continuationToken: undefined }, done: false }),
      });

      const page = await makeProvider().listObjects({ bucket: 'c' });

      expect(page.objects).toEqual([]);
      expect(page.isTruncated).toBe(false);
      expect(page.nextContinuationToken).toBeUndefined();
    });
  });

  describe('presign', () => {
    it('presignGet generates a read SAS and appends it to the blob URL', async () => {
      const url = await makeProvider().presignGet({ bucket: 'c', key: 'b', expiresInSeconds: 120 });

      expect(BlobSASPermissions.parse).toHaveBeenCalledWith('r');
      expect(generateBlobSASQueryParameters).toHaveBeenCalled();
      expect(url).toBe('https://acct.blob.core.windows.net/c/b?sv=2025&sig=MOCKSIG');
    });

    it('presignPut generates a create+write SAS', async () => {
      const url = await makeProvider().presignPut({ bucket: 'c', key: 'b', expiresInSeconds: 60, contentType: 'image/png' });

      expect(BlobSASPermissions.parse).toHaveBeenCalledWith('cw');
      expect(generateBlobSASQueryParameters).toHaveBeenCalled();
      expect(url).toBe('https://acct.blob.core.windows.net/c/b?sv=2025&sig=MOCKSIG');
    });

    it('presign works when constructed from a connection string carrying the account key', async () => {
      const connectionString = 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=key123==;EndpointSuffix=core.windows.net';
      const provider = new AzureBlobProvider({ accountName: '', connectionString });

      const url = await provider.presignGet({ bucket: 'c', key: 'b', expiresInSeconds: 30 });
      expect(url).toBe('https://acct.blob.core.windows.net/c/b?sv=2025&sig=MOCKSIG');
    });
  });

  describe('bucket operations', () => {
    it('createBucket calls createIfNotExists', async () => {
      h.container.createIfNotExists.mockResolvedValue({ succeeded: true });
      await makeProvider().createBucket('c');
      expect(h.service.getContainerClient).toHaveBeenCalledWith('c');
      expect(h.container.createIfNotExists).toHaveBeenCalled();
    });

    it('deleteBucket calls deleteIfExists', async () => {
      h.container.deleteIfExists.mockResolvedValue({ succeeded: true });
      await makeProvider().deleteBucket('c');
      expect(h.container.deleteIfExists).toHaveBeenCalled();
    });

    it('bucketExists returns the container exists() result', async () => {
      h.container.exists.mockResolvedValue(true);
      await expect(makeProvider().bucketExists('c')).resolves.toBe(true);
    });
  });

  // Azure's counterpart to S3 `NoSuchBucket`. A container row can outlive — or
  // precede — the physical container, and "the container isn't there" is a
  // not-found answer, not a server fault, so it must leave the gateway as 404.
  // The Azure SDK reports the condition on `code` (RestError), not `name`.
  describe('ContainerNotFound mapping', () => {
    function containerNotFound(): Error {
      const error = new Error('The specified container does not exist.');
      error.name = 'RestError';
      (error as { code?: string }).code = 'ContainerNotFound';
      (error as { statusCode?: number }).statusCode = 404;
      return error;
    }

    it('maps ContainerNotFound to NotFoundException on listObjects', async () => {
      h.byPage.mockReturnValue({ next: vi.fn().mockRejectedValue(containerNotFound()) });
      await expect(makeProvider().listObjects({ bucket: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('names the container in the message', async () => {
      h.byPage.mockReturnValue({ next: vi.fn().mockRejectedValue(containerNotFound()) });
      await expect(makeProvider().listObjects({ bucket: 'missing' })).rejects.toThrow(/missing/);
    });

    it('maps ContainerNotFound on object operations too', async () => {
      h.blockBlob.uploadData.mockRejectedValue(containerNotFound());
      h.blockBlob.downloadToBuffer.mockRejectedValue(containerNotFound());
      h.blockBlob.deleteIfExists.mockRejectedValue(containerNotFound());
      const provider = makeProvider();

      await expect(provider.putObject({ bucket: 'missing', key: 'k', body: Buffer.from('x') })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(provider.getObject({ bucket: 'missing', key: 'k' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(provider.deleteObject({ bucket: 'missing', key: 'k' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('also recognises the condition on details.errorCode', async () => {
      const error = new Error('The specified container does not exist.');
      (error as { details?: { errorCode?: string } }).details = { errorCode: 'ContainerNotFound' };
      h.byPage.mockReturnValue({ next: vi.fn().mockRejectedValue(error) });
      await expect(makeProvider().listObjects({ bucket: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leaves unrelated SDK errors untouched', async () => {
      const authError = new Error('AuthenticationFailed');
      (authError as { code?: string }).code = 'AuthenticationFailed';
      h.byPage.mockReturnValue({ next: vi.fn().mockRejectedValue(authError) });
      await expect(makeProvider().listObjects({ bucket: 'c' })).rejects.toThrow('AuthenticationFailed');
      h.byPage.mockReturnValue({ next: vi.fn().mockRejectedValue(authError) });
      await expect(makeProvider().listObjects({ bucket: 'c' })).rejects.not.toBeInstanceOf(NotFoundException);
    });

    it('does not change bucketExists, which answers a boolean', async () => {
      h.container.exists.mockResolvedValue(false);
      await expect(makeProvider().bucketExists('missing')).resolves.toBe(false);
    });
  });

  describe('setLifecycle', () => {
    it('throws StorageNotSupportedError (ILM is a management-plane operation)', async () => {
      await expect(makeProvider().setLifecycle('c', [])).rejects.toBeInstanceOf(StorageNotSupportedError);
    });
  });

  describe('healthCheck', () => {
    it('returns true when getProperties succeeds', async () => {
      h.service.getProperties.mockResolvedValue({});
      await expect(makeProvider().healthCheck()).resolves.toBe(true);
    });

    it('returns false when getProperties fails', async () => {
      h.service.getProperties.mockRejectedValue(new Error('unauthorized'));
      await expect(makeProvider().healthCheck()).resolves.toBe(false);
    });
  });
});

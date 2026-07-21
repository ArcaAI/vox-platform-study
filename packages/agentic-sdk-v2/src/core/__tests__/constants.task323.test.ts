/**
 * Endpoint Constants Tests
 *
 * Verifies the new admin/storage/SMR endpoint constant groups added so the
 * ui-playground can consume the new API surfaces "via the SDK". Every path is
 * source-verified against its API controller (paths omit the `/api/v1` prefix,
 * which the AgenticClient baseUrl carries).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
    ADMIN_CONSULTATION_ENDPOINTS,
    ADMIN_TRANSCRIPTION_JOB_ENDPOINTS,
    TENANT_BUCKET_ENDPOINTS,
    STORAGE_KEY_ENDPOINTS,
    TENANT_STORAGE_CONFIG_ENDPOINTS,
    SMR_ENDPOINTS,
} from '../constants';

describe('TASK-323 Phase 0 Endpoint Constants', () => {
    describe('ADMIN_CONSULTATION_ENDPOINTS (admin-consultation.controller.ts @Controller("admin/consultations"))', () => {
        it('LIST is /admin/consultations', () => {
            expect(ADMIN_CONSULTATION_ENDPOINTS.LIST).toBe('/admin/consultations');
        });
        it('GET(id) is /admin/consultations/:id', () => {
            expect(ADMIN_CONSULTATION_ENDPOINTS.GET('c-1')).toBe('/admin/consultations/c-1');
        });
        it('encodes the id path param', () => {
            expect(ADMIN_CONSULTATION_ENDPOINTS.GET('a/b')).toBe(`/admin/consultations/${encodeURIComponent('a/b')}`);
        });
    });

    describe('ADMIN_TRANSCRIPTION_JOB_ENDPOINTS (admin-transcription-job.controller.ts @Controller("admin/audio/transcription-jobs"))', () => {
        it('LIST is /admin/audio/transcription-jobs', () => {
            expect(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.LIST).toBe('/admin/audio/transcription-jobs');
        });
        it('STATS is /admin/audio/transcription-jobs/stats', () => {
            expect(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.STATS).toBe('/admin/audio/transcription-jobs/stats');
        });
        it('BY_STATUS(status) is /admin/audio/transcription-jobs/status/:status', () => {
            expect(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.BY_STATUS('COMPLETED')).toBe('/admin/audio/transcription-jobs/status/COMPLETED');
        });
        it('encodes the status path param', () => {
            expect(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.BY_STATUS('a b')).toBe(`/admin/audio/transcription-jobs/status/${encodeURIComponent('a b')}`);
        });
    });

    describe('TENANT_BUCKET_ENDPOINTS (tenant-bucket.controller.ts @Controller("admin/tenants/storage/buckets"))', () => {
        it('LIST is /admin/tenants/storage/buckets', () => {
            expect(TENANT_BUCKET_ENDPOINTS.LIST).toBe('/admin/tenants/storage/buckets');
        });
        it('DEFAULTS is /admin/tenants/storage/buckets/defaults (GET + PUT share it)', () => {
            expect(TENANT_BUCKET_ENDPOINTS.DEFAULTS).toBe('/admin/tenants/storage/buckets/defaults');
        });
        it('GET(id) is /admin/tenants/storage/buckets/:id', () => {
            expect(TENANT_BUCKET_ENDPOINTS.GET('b-1')).toBe('/admin/tenants/storage/buckets/b-1');
        });
        it('TREE(id) is /admin/tenants/storage/buckets/:id/tree', () => {
            expect(TENANT_BUCKET_ENDPOINTS.TREE('b-1')).toBe('/admin/tenants/storage/buckets/b-1/tree');
        });
        it('PRESIGNED_URL(id) is /admin/tenants/storage/buckets/:id/presigned-url', () => {
            expect(TENANT_BUCKET_ENDPOINTS.PRESIGNED_URL('b-1')).toBe('/admin/tenants/storage/buckets/b-1/presigned-url');
        });
        it('CREATE is /admin/tenants/storage/buckets', () => {
            expect(TENANT_BUCKET_ENDPOINTS.CREATE).toBe('/admin/tenants/storage/buckets');
        });
        it('DELETE(id) is /admin/tenants/storage/buckets/:id', () => {
            expect(TENANT_BUCKET_ENDPOINTS.DELETE('b-1')).toBe('/admin/tenants/storage/buckets/b-1');
        });
        it('DELETE_OBJECT(id) is /admin/tenants/storage/buckets/:id/objects (TASK-328 A7)', () => {
            expect(TENANT_BUCKET_ENDPOINTS.DELETE_OBJECT('b-1')).toBe('/admin/tenants/storage/buckets/b-1/objects');
        });
        it('PROVISION(tenantId) is /admin/tenants/storage/buckets/provision/:tenantId', () => {
            expect(TENANT_BUCKET_ENDPOINTS.PROVISION('t-1')).toBe('/admin/tenants/storage/buckets/provision/t-1');
        });
        it('encodes id/tenantId path params', () => {
            expect(TENANT_BUCKET_ENDPOINTS.TREE('a/b')).toBe(`/admin/tenants/storage/buckets/${encodeURIComponent('a/b')}/tree`);
            expect(TENANT_BUCKET_ENDPOINTS.DELETE_OBJECT('a/b')).toBe(`/admin/tenants/storage/buckets/${encodeURIComponent('a/b')}/objects`);
            expect(TENANT_BUCKET_ENDPOINTS.PROVISION('a b')).toBe(`/admin/tenants/storage/buckets/provision/${encodeURIComponent('a b')}`);
        });
    });

    describe('STORAGE_KEY_ENDPOINTS (storage-access-key.controller.ts @Controller("admin/tenants/storage/keys"))', () => {
        it('LIST is /admin/tenants/storage/keys', () => {
            expect(STORAGE_KEY_ENDPOINTS.LIST).toBe('/admin/tenants/storage/keys');
        });
        it('CREATE is /admin/tenants/storage/keys (same path as LIST)', () => {
            expect(STORAGE_KEY_ENDPOINTS.CREATE).toBe('/admin/tenants/storage/keys');
        });
        it('DELETE(id) is /admin/tenants/storage/keys/:id', () => {
            expect(STORAGE_KEY_ENDPOINTS.DELETE('k-1')).toBe('/admin/tenants/storage/keys/k-1');
        });
    });

    describe('TENANT_STORAGE_CONFIG_ENDPOINTS (tenant-storage-config-admin.controller.ts @Controller("admin/tenants/storage/config"))', () => {
        it('LIST is /admin/tenants/storage/config', () => {
            expect(TENANT_STORAGE_CONFIG_ENDPOINTS.LIST).toBe('/admin/tenants/storage/config');
        });
        it('EFFECTIVE is /admin/tenants/storage/config/effective', () => {
            expect(TENANT_STORAGE_CONFIG_ENDPOINTS.EFFECTIVE).toBe('/admin/tenants/storage/config/effective');
        });
        it('UPSERT is /admin/tenants/storage/config (PUT, same as LIST)', () => {
            expect(TENANT_STORAGE_CONFIG_ENDPOINTS.UPSERT).toBe('/admin/tenants/storage/config');
        });
        it('DELETE(id) is /admin/tenants/storage/config/:id', () => {
            expect(TENANT_STORAGE_CONFIG_ENDPOINTS.DELETE('s-1')).toBe('/admin/tenants/storage/config/s-1');
        });
    });

    describe('SMR_ENDPOINTS (smr-proxy.controller.ts @Controller("text"))', () => {
        it('GENERATE is /text/generate', () => {
            expect(SMR_ENDPOINTS.GENERATE).toBe('/text/generate');
        });
        it('GENERATE_ASSEMBLED is /text/generate/assembled', () => {
            expect(SMR_ENDPOINTS.GENERATE_ASSEMBLED).toBe('/text/generate/assembled');
        });
        it('PROVIDERS is /text/providers', () => {
            expect(SMR_ENDPOINTS.PROVIDERS).toBe('/text/providers');
        });
        it('TASK(id) is /text/tasks/:id', () => {
            expect(SMR_ENDPOINTS.TASK('t-1')).toBe('/text/tasks/t-1');
        });
        it('TASK_CANCEL(id) is /text/tasks/:id/cancel', () => {
            expect(SMR_ENDPOINTS.TASK_CANCEL('t-1')).toBe('/text/tasks/t-1/cancel');
        });
        it('TASK_STREAM(id) is /text/tasks/:id/stream', () => {
            expect(SMR_ENDPOINTS.TASK_STREAM('t-1')).toBe('/text/tasks/t-1/stream');
        });
        it('encodes the task id path param', () => {
            expect(SMR_ENDPOINTS.TASK('a/b')).toBe(`/text/tasks/${encodeURIComponent('a/b')}`);
        });
    });

    describe('static vs dynamic shape', () => {
        it('static endpoints are strings, dynamic endpoints are functions', () => {
            expect(typeof ADMIN_CONSULTATION_ENDPOINTS.LIST).toBe('string');
            expect(typeof ADMIN_CONSULTATION_ENDPOINTS.GET).toBe('function');
            expect(typeof TENANT_BUCKET_ENDPOINTS.DEFAULTS).toBe('string');
            expect(typeof TENANT_BUCKET_ENDPOINTS.PROVISION).toBe('function');
            expect(typeof SMR_ENDPOINTS.GENERATE_ASSEMBLED).toBe('string');
            expect(typeof SMR_ENDPOINTS.TASK_STREAM).toBe('function');
        });
    });
});

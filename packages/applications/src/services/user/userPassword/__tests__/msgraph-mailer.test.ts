/**
 * TASK-400 — MS-Graph password-reset mail transport + env-driven selection.
 *
 * The transport wraps the existing `MicrosoftGraphIntegration.sendEmail`
 * (client-credentials app) behind `IPasswordResetMailer`. Selection contract:
 * all four MSGRAPH_* vars present → graph transport; anything missing → the
 * logging fallback (never throws, reports `false`). The reset link embedded in
 * the mail is absolute (`PASSWORD_RESET_BASE_URL` + resetPath) and the mail
 * must NEVER be treated as sent when Graph rejects the call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MsGraphPasswordResetMailer, resolvePasswordResetMailerConfig, createPasswordResetMailer } from '../msgraph-mailer';
import { DEFAULT_PASSWORD_RESET_BASE_URL, LoggingPasswordResetMailer } from '../IPasswordResetMailer';
import { DevOutboxPasswordResetMailer } from '../dev-outbox-mailer';

const sendEmail = vi.fn();
const graphStub = { sendEmail } as never;

const FULL_ENV = {
    MSGRAPH_CLIENT_ID: 'client-id',
    MSGRAPH_CLIENT_SECRET: 'shhh',
    MSGRAPH_TENANT_ID: 'tenant-id',
    MSGRAPH_SENDER: 'noreply@example.com',
    PASSWORD_RESET_BASE_URL: 'https://admin.example.com',
};

describe('resolvePasswordResetMailerConfig', () => {
    it('selects graph when all four MSGRAPH_* vars are present', () => {
        const config = resolvePasswordResetMailerConfig(FULL_ENV);
        expect(config.kind).toBe('graph');
        if (config.kind === 'graph') {
            expect(config.clientId).toBe('client-id');
            expect(config.sender).toBe('noreply@example.com');
            expect(config.baseUrl).toBe('https://admin.example.com');
        }
    });

    it('falls back to logging when any credential is missing, listing the gaps', () => {
        const { MSGRAPH_CLIENT_SECRET: _omit, ...partial } = FULL_ENV;
        void _omit;
        const config = resolvePasswordResetMailerConfig(partial);
        expect(config.kind).toBe('logging');
        if (config.kind === 'logging') {
            expect(config.missing).toContain('MSGRAPH_CLIENT_SECRET');
        }
    });

    it('falls back to logging for an empty env and lists all four vars', () => {
        const config = resolvePasswordResetMailerConfig({});
        expect(config.kind).toBe('logging');
        if (config.kind === 'logging') {
            expect(config.missing).toEqual(
                expect.arrayContaining(['MSGRAPH_CLIENT_ID', 'MSGRAPH_CLIENT_SECRET', 'MSGRAPH_TENANT_ID', 'MSGRAPH_SENDER']),
            );
        }
    });

    it('defaults the base URL to the local admin app when unset', () => {
        const { PASSWORD_RESET_BASE_URL: _omit, ...rest } = FULL_ENV;
        void _omit;
        const config = resolvePasswordResetMailerConfig(rest);
        if (config.kind === 'graph') {
            expect(config.baseUrl).toBe(DEFAULT_PASSWORD_RESET_BASE_URL);
        } else {
            throw new Error('expected graph config');
        }
    });
});

describe('MsGraphPasswordResetMailer', () => {
    beforeEach(() => vi.clearAllMocks());

    const mailer = () =>
        new MsGraphPasswordResetMailer(graphStub, { sender: 'noreply@example.com', baseUrl: 'https://admin.example.com' });

    it('sends via Graph with an ABSOLUTE reset link and returns true', async () => {
        sendEmail.mockResolvedValue(undefined);

        const ok = await mailer().sendResetLink({
            email: 'doc@example.com',
            resetPath: '/reset-password?token=abc123',
            token: 'abc123',
            expiresInSeconds: 3600,
        });

        expect(ok).toBe(true);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const [from, subject, content, recipients] = sendEmail.mock.calls[0];
        expect(from).toBe('noreply@example.com');
        expect(subject).toMatch(/password reset/i);
        expect(content).toContain('https://admin.example.com/reset-password?token=abc123');
        expect(content).toMatch(/60 minutes/);
        expect(recipients).toEqual(['doc@example.com']);
    });

    it('uses the shared localhost fallback when the Graph base URL is unset', async () => {
        sendEmail.mockResolvedValue(undefined);
        const { PASSWORD_RESET_BASE_URL: _omit, ...envWithoutBaseUrl } = FULL_ENV;
        void _omit;
        const config = resolvePasswordResetMailerConfig(envWithoutBaseUrl);
        if (config.kind !== 'graph') throw new Error('expected graph config');

        const ok = await new MsGraphPasswordResetMailer(graphStub, { sender: config.sender, baseUrl: config.baseUrl }).sendResetLink({
            email: 'doc@example.com',
            resetPath: '/reset-password?token=default',
            token: 'default',
            expiresInSeconds: 3600,
        });

        expect(ok).toBe(true);
        expect(sendEmail.mock.calls[0][2]).toContain(`${DEFAULT_PASSWORD_RESET_BASE_URL}/reset-password?token=default`);
    });

    it('returns false (never throws) when Graph rejects the send', async () => {
        sendEmail.mockRejectedValue(new Error('403 from Graph'));

        await expect(
            mailer().sendResetLink({ email: 'doc@example.com', resetPath: '/reset-password?token=t', token: 't', expiresInSeconds: 3600 }),
        ).resolves.toBe(false);
    });
});

describe('DevOutboxPasswordResetMailer', () => {
    const outboxFile = join(tmpdir(), `task-400-outbox-test-${process.pid}.jsonl`);

    beforeEach(() => rmSync(outboxFile, { force: true }));

    it('appends the payload (incl. raw token) as JSONL and reports NOT sent', async () => {
        const mailer = new DevOutboxPasswordResetMailer(outboxFile);

        const sent = await mailer.sendResetLink({
            email: 'doc@example.com',
            resetPath: '/reset-password?token=raw-token-1',
            token: 'raw-token-1',
            expiresInSeconds: 3600,
        });
        await mailer.sendResetLink({ email: 'two@example.com', resetPath: '/reset-password?token=raw-token-2', token: 'raw-token-2', expiresInSeconds: 3600 });

        expect(sent).toBe(false); // outbox capture is NOT real delivery
        const lines = readFileSync(outboxFile, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toMatchObject({ email: 'doc@example.com', token: 'raw-token-1' });
        expect(JSON.parse(lines[1])).toMatchObject({ email: 'two@example.com', token: 'raw-token-2' });
    });

    it('never throws even when the path is unwritable', async () => {
        const mailer = new DevOutboxPasswordResetMailer('/nonexistent-dir-task400/outbox.jsonl');
        await expect(
            mailer.sendResetLink({ email: 'x@example.com', resetPath: '/r?token=t', token: 't', expiresInSeconds: 60 }),
        ).resolves.toBe(false);
    });
});

describe('createPasswordResetMailer', () => {
    it('creates the graph mailer when creds are present', () => {
        expect(createPasswordResetMailer(FULL_ENV)).toBeInstanceOf(MsGraphPasswordResetMailer);
    });

    it('creates the DEV OUTBOX mailer when creds are absent outside production', () => {
        expect(createPasswordResetMailer({ NODE_ENV: 'test' })).toBeInstanceOf(DevOutboxPasswordResetMailer);
        expect(createPasswordResetMailer({})).toBeInstanceOf(DevOutboxPasswordResetMailer);
    });

    it('creates the plain logging mailer when creds are absent in production', () => {
        expect(createPasswordResetMailer({ NODE_ENV: 'production' })).toBeInstanceOf(LoggingPasswordResetMailer);
    });
});

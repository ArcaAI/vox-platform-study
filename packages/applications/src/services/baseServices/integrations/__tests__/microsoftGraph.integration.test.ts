/**
 * MicrosoftGraphIntegration Unit Tests
 *
 * Tests for the Microsoft Graph API integration service.
 *
 * Testing Strategy:
 * - Test actual API call behavior and response handling
 * - Verify correct API endpoints are called with proper parameters
 * - Test error handling for various failure scenarios
 * - Use complete mock responses matching real Graph API structure
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { MicrosoftGraphIntegration } from '../microsoftGraph/microsoftGraph.integration';

// Mock @microsoft/microsoft-graph-client - external API boundary
vi.mock('@microsoft/microsoft-graph-client', () => ({
    Client: {
        initWithMiddleware: vi.fn().mockReturnValue({
            api: vi.fn().mockReturnThis(),
            get: vi.fn(),
            post: vi.fn(),
            select: vi.fn().mockReturnThis(),
            top: vi.fn().mockReturnThis(),
        }),
    },
}));

// Mock @azure/msal-node - external auth boundary
// Complete mock matching real MSAL response structure
vi.mock('@azure/msal-node', () => {
    class MockConfidentialClientApplication {
        private config: any;

        acquireTokenByClientCredential = vi.fn().mockResolvedValue({
            accessToken: 'mock-access-token',
            expiresOn: new Date(Date.now() + 3600000),
            scopes: ['https://graph.microsoft.com/.default'],
            tokenType: 'Bearer',
            tenantId: 'test-tenant-id',
            account: null,
            idToken: '',
            idTokenClaims: {},
            fromCache: false,
            correlationId: 'test-correlation-id',
        });

        constructor(config: any) {
            this.config = config;
        }
    }

    return {
        ConfidentialClientApplication: MockConfidentialClientApplication,
    };
});

describe('MicrosoftGraphIntegration', () => {
    let integration: MicrosoftGraphIntegration;
    let mockClient: {
        api: Mock;
        get: Mock;
        post: Mock;
        select: Mock;
        top: Mock;
    };

    const testConfig = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'test-tenant-id',
        scopes: ['https://graph.microsoft.com/.default'],
    };

    beforeEach(async () => {
        vi.clearAllMocks();

        // Setup mock client
        mockClient = {
            api: vi.fn().mockReturnThis(),
            get: vi.fn(),
            post: vi.fn(),
            select: vi.fn().mockReturnThis(),
            top: vi.fn().mockReturnThis(),
        };

        const { Client } = await import('@microsoft/microsoft-graph-client');
        (Client.initWithMiddleware as Mock).mockReturnValue(mockClient);

        integration = new MicrosoftGraphIntegration(
            testConfig.clientId,
            testConfig.clientSecret,
            testConfig.tenantId,
            testConfig.scopes,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create integration with provided credentials', async () => {
            // Verify the integration was created successfully
            expect(integration).toBeDefined();
            // The constructor should have initialized the MSAL client
        });

        it('should initialize Graph client with auth provider', async () => {
            const { Client } = await import('@microsoft/microsoft-graph-client');

            expect(Client.initWithMiddleware).toHaveBeenCalledWith({
                authProvider: expect.objectContaining({
                    getAccessToken: expect.any(Function),
                }),
            });
        });
    });

    describe('fetchUserDetails', () => {
        it('should fetch user details by ID and return complete user object', async () => {
            // Complete mock matching real Graph API user response
            const mockUser = {
                id: 'user-123',
                displayName: 'John Doe',
                mail: 'john.doe@example.com',
                userPrincipalName: 'john.doe@example.com',
                givenName: 'John',
                surname: 'Doe',
                jobTitle: 'Software Engineer',
                department: 'Engineering',
                officeLocation: 'Building A',
                mobilePhone: '+1-555-0100',
                businessPhones: ['+1-555-0101'],
            };
            mockClient.get.mockResolvedValue(mockUser);

            const result = await integration.fetchUserDetails('user-123');

            // Verify BEHAVIOR: correct API endpoint called
            expect(mockClient.api).toHaveBeenCalledWith('/users/user-123');
            // Verify BEHAVIOR: complete user data returned
            expect(result.id).toBe('user-123');
            expect(result.displayName).toBe('John Doe');
            expect(result.mail).toBe('john.doe@example.com');
        });

        it('should throw descriptive error when user not found', async () => {
            const notFoundError = new Error('User not found');
            (notFoundError as any).statusCode = 404;
            mockClient.get.mockRejectedValue(notFoundError);

            // Verify BEHAVIOR: error is propagated with context
            await expect(integration.fetchUserDetails('invalid-id')).rejects.toThrow('User not found');
        });

        it('should handle user with minimal data', async () => {
            // Some users may have minimal profile data
            const minimalUser = {
                id: 'user-456',
                displayName: 'Guest User',
                mail: null,
            };
            mockClient.get.mockResolvedValue(minimalUser);

            const result = await integration.fetchUserDetails('user-456');

            // Verify BEHAVIOR: handles null/missing fields gracefully
            expect(result.id).toBe('user-456');
            expect(result.mail).toBeNull();
        });
    });

    describe('sendEmail', () => {
        it('should send email successfully', async () => {
            mockClient.post.mockResolvedValue(undefined);

            await integration.sendEmail(
                'sender-id',
                'Test Subject',
                'Test content',
                ['recipient@example.com'],
            );

            expect(mockClient.api).toHaveBeenCalledWith('/users/sender-id/sendMail');
            expect(mockClient.post).toHaveBeenCalledWith({
                message: {
                    subject: 'Test Subject',
                    body: {
                        contentType: 'Text',
                        content: 'Test content',
                    },
                    toRecipients: [
                        {
                            emailAddress: { address: 'recipient@example.com' },
                        },
                    ],
                },
                saveToSentItems: 'true',
            });
        });

        it('should send email to multiple recipients', async () => {
            mockClient.post.mockResolvedValue(undefined);

            await integration.sendEmail(
                'sender-id',
                'Test Subject',
                'Test content',
                ['recipient1@example.com', 'recipient2@example.com', 'recipient3@example.com'],
            );

            expect(mockClient.post).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.objectContaining({
                        toRecipients: [
                            { emailAddress: { address: 'recipient1@example.com' } },
                            { emailAddress: { address: 'recipient2@example.com' } },
                            { emailAddress: { address: 'recipient3@example.com' } },
                        ],
                    }),
                }),
            );
        });

        it('should throw error when email send fails', async () => {
            mockClient.post.mockRejectedValue(new Error('Send failed'));

            await expect(
                integration.sendEmail('sender-id', 'Subject', 'Content', ['recipient@example.com']),
            ).rejects.toThrow('Send failed');
        });
    });

    describe('fetchEmailsByEmailAddress', () => {
        it('should fetch emails from inbox', async () => {
            const mockMessages = {
                value: [
                    {
                        subject: 'Test Email 1',
                        from: { emailAddress: { address: 'sender@example.com', name: 'Sender' } },
                        receivedDateTime: '2024-01-15T10:00:00Z',
                        body: { contentType: 'text', content: 'Email body 1' },
                    },
                    {
                        subject: 'Test Email 2',
                        from: { emailAddress: { address: 'sender2@example.com', name: 'Sender 2' } },
                        receivedDateTime: '2024-01-15T11:00:00Z',
                        body: { contentType: 'text', content: 'Email body 2' },
                    },
                ],
            };
            mockClient.get.mockResolvedValue(mockMessages);

            const result = await integration.fetchEmailsByEmailAddress('user@example.com', 10);

            expect(mockClient.api).toHaveBeenCalledWith('/users/user@example.com/mailFolders/Inbox/messages');
            expect(mockClient.select).toHaveBeenCalledWith('subject,from,receivedDateTime,body');
            expect(mockClient.top).toHaveBeenCalledWith(10);
            expect(result).toEqual(mockMessages.value);
        });

        it('should throw error when email fetch fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Access denied'));

            await expect(
                integration.fetchEmailsByEmailAddress('user@example.com', 5),
            ).rejects.toThrow('Access denied');
        });
    });

    describe('getSharePointSites', () => {
        it('should fetch SharePoint sites', async () => {
            const mockSites = {
                value: [
                    { id: 'site-1', name: 'Site 1', webUrl: 'https://example.sharepoint.com/sites/site1' },
                    { id: 'site-2', name: 'Site 2', webUrl: 'https://example.sharepoint.com/sites/site2' },
                ],
            };
            mockClient.get.mockResolvedValue(mockSites);

            const result = await integration.getSharePointSites();

            expect(mockClient.api).toHaveBeenCalledWith('/sites');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: 'site-1',
                name: 'Site 1',
                webUrl: 'https://example.sharepoint.com/sites/site1',
            });
        });

        it('should throw error when sites fetch fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Sites not accessible'));

            await expect(integration.getSharePointSites()).rejects.toThrow('Sites not accessible');
        });
    });

    describe('getSharePointSiteDrives', () => {
        it('should fetch drives for a site', async () => {
            const mockDrives = {
                value: [
                    { id: 'drive-1', name: 'Documents' },
                    { id: 'drive-2', name: 'Shared Documents' },
                ],
            };
            mockClient.get.mockResolvedValue(mockDrives);

            const result = await integration.getSharePointSiteDrives('site-123');

            expect(mockClient.api).toHaveBeenCalledWith('/sites/site-123/drives');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ id: 'drive-1', name: 'Documents' });
        });

        it('should throw error when drives fetch fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Drive not found'));

            await expect(integration.getSharePointSiteDrives('invalid-site')).rejects.toThrow('Drive not found');
        });
    });

    describe('getSharePointDriveItems', () => {
        it('should fetch items from a drive', async () => {
            const mockItems = {
                value: [
                    { id: 'item-1', name: 'Document.docx', webUrl: 'https://example.sharepoint.com/doc1' },
                    { id: 'item-2', name: 'Spreadsheet.xlsx', webUrl: 'https://example.sharepoint.com/doc2' },
                ],
            };
            mockClient.get.mockResolvedValue(mockItems);

            const result = await integration.getSharePointDriveItems('drive-123');

            expect(mockClient.api).toHaveBeenCalledWith('/drives/drive-123/root/children');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: 'item-1',
                name: 'Document.docx',
                webUrl: 'https://example.sharepoint.com/doc1',
            });
        });

        it('should throw error when items fetch fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Items not accessible'));

            await expect(integration.getSharePointDriveItems('invalid-drive')).rejects.toThrow('Items not accessible');
        });
    });

    describe('fetchAllUserEmails', () => {
        it('should fetch emails for all users', async () => {
            const mockUsers = {
                value: [
                    { id: 'user-1', displayName: 'User 1', mail: 'user1@example.com' },
                    { id: 'user-2', displayName: 'User 2', mail: 'user2@example.com' },
                ],
            };
            const mockMessages = {
                value: [
                    { subject: 'Email 1', from: {}, receivedDateTime: '2024-01-15T10:00:00Z', body: {} },
                ],
            };

            mockClient.get
                .mockResolvedValueOnce(mockUsers) // First call for users
                .mockResolvedValue(mockMessages); // Subsequent calls for messages

            const result = await integration.fetchAllUserEmails(5);

            expect(result).toHaveLength(2);
            expect(result[0].user).toEqual(mockUsers.value[0]);
            expect(result[0].messages).toEqual(mockMessages.value);
        });

        it('should throw error when fetching user emails fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Users fetch failed'));

            await expect(integration.fetchAllUserEmails(5)).rejects.toThrow('Users fetch failed');
        });
    });

    describe('fetchAllUsersWithGroups', () => {
        it('should fetch users with their group memberships', async () => {
            const mockUsers = {
                value: [
                    { id: 'user-1', displayName: 'User 1', mail: 'user1@example.com' },
                ],
            };
            const mockGroups = {
                value: [
                    { id: 'group-1', displayName: 'Group 1' },
                    { id: 'group-2', displayName: 'Group 2' },
                ],
            };

            mockClient.get
                .mockResolvedValueOnce(mockUsers)
                .mockResolvedValue(mockGroups);

            const result = await integration.fetchAllUsersWithGroups();

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('user-1');
            expect(result[0].groups).toHaveLength(2);
            expect(result[0].groups[0]).toEqual({ id: 'group-1', displayName: 'Group 1' });
        });

        it('should throw error when fetching users with groups fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Groups fetch failed'));

            await expect(integration.fetchAllUsersWithGroups()).rejects.toThrow('Groups fetch failed');
        });
    });

    describe('fetchAllGroups', () => {
        it('should fetch all groups', async () => {
            const mockGroups = {
                value: [
                    { id: 'group-1', displayName: 'Engineering' },
                    { id: 'group-2', displayName: 'Marketing' },
                    { id: 'group-3', displayName: 'Sales' },
                ],
            };
            mockClient.get.mockResolvedValue(mockGroups);

            const result = await integration.fetchAllGroups();

            expect(mockClient.api).toHaveBeenCalledWith('/groups');
            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({ id: 'group-1', displayName: 'Engineering' });
        });

        it('should throw error when groups fetch fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Groups not accessible'));

            await expect(integration.fetchAllGroups()).rejects.toThrow('Groups not accessible');
        });
    });

    describe('fetchAllUsers', () => {
        it('should fetch all users', async () => {
            const mockUsers = {
                value: [
                    { id: 'user-1', displayName: 'John Doe', mail: 'john@example.com' },
                    { id: 'user-2', displayName: 'Jane Smith', mail: 'jane@example.com' },
                ],
            };
            mockClient.get.mockResolvedValue(mockUsers);

            const result = await integration.fetchAllUsers();

            expect(mockClient.api).toHaveBeenCalledWith('/users');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: 'user-1',
                displayName: 'John Doe',
                mail: 'john@example.com',
            });
        });

        it('should throw error when users fetch fails', async () => {
            mockClient.get.mockRejectedValue(new Error('Users not accessible'));

            await expect(integration.fetchAllUsers()).rejects.toThrow('Users not accessible');
        });
    });

    describe('authentication', () => {
        it('should initialize with auth provider', async () => {
            const { Client } = await import('@microsoft/microsoft-graph-client');

            // Verify the client was initialized with an auth provider
            expect(Client.initWithMiddleware).toHaveBeenCalledWith(
                expect.objectContaining({
                    authProvider: expect.objectContaining({
                        getAccessToken: expect.any(Function),
                    }),
                }),
            );
        });

        it('should use configured credentials', () => {
            // The integration should have been created with the test config
            expect(integration).toBeDefined();
            // Verify the integration was created (constructor ran without error)
        });
    });

    describe('error handling', () => {
        it('should propagate API errors with original message', async () => {
            const apiError = new Error('API Error: Invalid request');
            (apiError as any).statusCode = 400;
            (apiError as any).code = 'BadRequest';
            mockClient.get.mockRejectedValue(apiError);

            // Verify BEHAVIOR: error message is preserved for debugging
            await expect(integration.fetchUserDetails('user-123')).rejects.toThrow('API Error: Invalid request');
        });

        it('should handle network connectivity errors', async () => {
            const networkError = new Error('getaddrinfo ENOTFOUND graph.microsoft.com');
            (networkError as any).code = 'ENOTFOUND';
            (networkError as any).syscall = 'getaddrinfo';
            mockClient.get.mockRejectedValue(networkError);

            // Verify BEHAVIOR: network errors are propagated
            await expect(integration.fetchAllUsers()).rejects.toThrow('ENOTFOUND');
        });

        it('should handle rate limiting (429) errors', async () => {
            const rateLimitError = new Error('Too many requests');
            (rateLimitError as any).statusCode = 429;
            (rateLimitError as any).headers = {
                'Retry-After': '30',
            };
            mockClient.get.mockRejectedValue(rateLimitError);

            // Verify BEHAVIOR: rate limit errors are propagated for retry handling
            await expect(integration.fetchAllUsers()).rejects.toThrow('Too many requests');
        });

        it('should handle authentication errors', async () => {
            const authError = new Error('Invalid client credentials');
            (authError as any).statusCode = 401;
            (authError as any).code = 'InvalidAuthenticationToken';
            mockClient.get.mockRejectedValue(authError);

            // Verify BEHAVIOR: auth errors are propagated
            await expect(integration.fetchAllUsers()).rejects.toThrow('Invalid client credentials');
        });

        it('should handle permission errors', async () => {
            const permissionError = new Error('Insufficient privileges to complete the operation');
            (permissionError as any).statusCode = 403;
            (permissionError as any).code = 'Authorization_RequestDenied';
            mockClient.get.mockRejectedValue(permissionError);

            // Verify BEHAVIOR: permission errors are propagated
            await expect(integration.fetchAllUsers()).rejects.toThrow('Insufficient privileges');
        });

        it('should handle service unavailable errors', async () => {
            const serviceError = new Error('Service temporarily unavailable');
            (serviceError as any).statusCode = 503;
            mockClient.get.mockRejectedValue(serviceError);

            // Verify BEHAVIOR: service errors are propagated for retry handling
            await expect(integration.fetchAllUsers()).rejects.toThrow('Service temporarily unavailable');
        });
    });
});

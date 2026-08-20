import type { CorePrismaClient } from '../../../client';
import {
  SEED_TENANT_ID,
  SEED_CUSTOMER_TENANT_IDS,
  SEED_USER_IDS,
  SEED_ROLE_IDS,
  SEED_API_KEY_IDS,
  SEED_CONSULTATION_IDS,
  SEED_CONTEXT_ITEM_IDS,
  SEED_DEPARTMENT_IDS,
  SEED_AUDIT_LOG_IDS,
} from './00-constants';

/**
 * Audit Log Seed Data — Compliance & Traceability
 *
 * Seeds 10 realistic audit log entries that exercise the audit trail
 * user stories (42, 64, 89, 107). Covers:
 *   - User authentication events (LOGIN)
 *   - User management (CREATE user, ASSIGN role)
 *   - API key lifecycle (CREATE)
 *   - Consultation lifecycle (CREATE, UPDATE status)
 *   - Summary generation and editing (CREATE, UPDATE context items)
 *
 * Each entry includes correlationId/causationId for distributed tracing
 * and realistic data/previousData payloads for audit review.
 */

const CORRELATION_PREFIX = 'corr-seed';

export const DEFAULT_AUDIT_LOGS = [
  // 1. Platform admin (`super_admin` user) login
  {
    id: SEED_AUDIT_LOG_IDS.LOGIN_SUPER_ADMIN,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.SUPER_ADMIN,
    responsibleIp: '10.0.1.100',
    resourceType: 'User' as const,
    resourceId: SEED_USER_IDS.SUPER_ADMIN,
    correlationId: `${CORRELATION_PREFIX}-login-001`,
    causationId: null,
    action: 'LOGIN' as const,
    eventType: 'AUTHENTICATION',
    success: true,
    data: {
      username: 'super_admin',
      loginMethod: 'password',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
    previousData: {},
    metadata: { source: 'web-ui', sessionId: 'sess-seed-001' },
    createdBy: SEED_USER_IDS.SUPER_ADMIN,
    createdAt: new Date('2026-02-20T08:00:00Z'),
  },
  // 2. Doctor login
  {
    id: SEED_AUDIT_LOG_IDS.LOGIN_DOCTOR,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.DOCTOR,
    responsibleIp: '10.0.2.50',
    resourceType: 'User' as const,
    resourceId: SEED_USER_IDS.DOCTOR,
    correlationId: `${CORRELATION_PREFIX}-login-002`,
    causationId: null,
    action: 'LOGIN' as const,
    eventType: 'AUTHENTICATION',
    success: true,
    data: {
      username: 'doctor',
      loginMethod: 'api_key',
      apiKeyId: SEED_API_KEY_IDS.SDK_DOCTOR,
    },
    previousData: {},
    metadata: { source: 'sdk', sdkVersion: '2.1.0' },
    createdBy: SEED_USER_IDS.DOCTOR,
    createdAt: new Date('2026-02-20T08:30:00Z'),
  },
  // 3. Admin creates nurse user
  {
    id: SEED_AUDIT_LOG_IDS.CREATE_USER_NURSE,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.TENANT_ADMIN,
    responsibleIp: '10.0.1.100',
    resourceType: 'User' as const,
    resourceId: SEED_USER_IDS.NURSE,
    correlationId: `${CORRELATION_PREFIX}-user-mgmt-001`,
    causationId: null,
    action: 'CREATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: {
      userId: SEED_USER_IDS.NURSE,
      username: 'nurse',
      roles: ['NURSE'],
      profile: { firstName: 'Emily', lastName: 'Taylor' },
    },
    previousData: {},
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.TENANT_ADMIN,
    createdAt: new Date('2026-02-20T09:00:00Z'),
  },
  // 4. Admin assigns DOCTOR role to doctor_surgery
  {
    id: SEED_AUDIT_LOG_IDS.ASSIGN_ROLE_DOCTOR,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.TENANT_ADMIN,
    responsibleIp: '10.0.1.100',
    resourceType: 'UserRoleAssignment' as const,
    resourceId: null,
    correlationId: `${CORRELATION_PREFIX}-rbac-001`,
    causationId: `${CORRELATION_PREFIX}-user-mgmt-001`,
    action: 'CREATE' as const,
    eventType: 'AUTHORIZATION',
    success: true,
    data: {
      userId: SEED_USER_IDS.DOCTOR_SURGERY,
      roleId: SEED_ROLE_IDS.DOCTOR,
      roleName: 'DOCTOR',
      assignedBy: SEED_USER_IDS.TENANT_ADMIN,
    },
    previousData: {},
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.TENANT_ADMIN,
    createdAt: new Date('2026-02-20T09:15:00Z'),
  },
  // 5. Admin creates webhook API key
  {
    id: SEED_AUDIT_LOG_IDS.CREATE_APIKEY,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.TENANT_ADMIN,
    responsibleIp: '10.0.1.100',
    resourceType: 'ApiKey' as const,
    resourceId: SEED_API_KEY_IDS.WEBHOOK_ADMIN,
    correlationId: `${CORRELATION_PREFIX}-apikey-001`,
    causationId: null,
    action: 'CREATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: {
      apiKeyId: SEED_API_KEY_IDS.WEBHOOK_ADMIN,
      keyName: 'Webhook Integration Key',
      keyType: 'WEBHOOK',
      userId: SEED_USER_IDS.TENANT_ADMIN,
      scopes: ['webhooks', 'events'],
    },
    previousData: {},
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.TENANT_ADMIN,
    createdAt: new Date('2026-02-20T09:30:00Z'),
  },
  // 6. Doctor creates a consultation
  {
    id: SEED_AUDIT_LOG_IDS.CREATE_CONSULTATION,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.DOCTOR,
    responsibleIp: '10.0.2.50',
    resourceType: 'Consultation' as const,
    resourceId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    correlationId: `${CORRELATION_PREFIX}-consult-001`,
    causationId: `${CORRELATION_PREFIX}-login-002`,
    action: 'CREATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: {
      consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
      patientId: 'PAT-20250101-001',
      departmentId: '70000000-0000-0000-0000-000000000001',
      visitType: 'NEW_PATIENT',
      status: 'OPEN',
    },
    previousData: {},
    metadata: { source: 'sdk', sdkVersion: '2.1.0' },
    createdBy: SEED_USER_IDS.DOCTOR,
    createdAt: new Date('2025-12-15T10:00:00Z'),
  },
  // 7. Consultation status → CLOSED
  {
    id: SEED_AUDIT_LOG_IDS.UPDATE_CONSULTATION_STATUS,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.DOCTOR,
    responsibleIp: '10.0.2.50',
    resourceType: 'Consultation' as const,
    resourceId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    correlationId: `${CORRELATION_PREFIX}-consult-001`,
    causationId: `${CORRELATION_PREFIX}-consult-001`,
    action: 'UPDATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: {
      consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
      field: 'metadata.status',
      newValue: 'CLOSED',
    },
    previousData: {
      field: 'metadata.status',
      oldValue: 'REVIEW',
    },
    metadata: { source: 'sdk', sdkVersion: '2.1.0' },
    createdBy: SEED_USER_IDS.DOCTOR,
    createdAt: new Date('2025-12-15T11:00:00Z'),
  },
  // 8. AI generates summary
  {
    id: SEED_AUDIT_LOG_IDS.GENERATE_SUMMARY,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: null,
    responsibleIp: null,
    resourceType: 'ContextItem' as const,
    resourceId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
    correlationId: `${CORRELATION_PREFIX}-summary-001`,
    causationId: `${CORRELATION_PREFIX}-consult-001`,
    action: 'CREATE' as const,
    eventType: 'SYSTEM',
    success: true,
    data: {
      contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
      type: 'RAW_SUMMARY',
      source: 'AI',
      aiModelId: 'gpt-4o',
      processingTimeMs: 4200,
      inputTokens: 850,
      outputTokens: 420,
    },
    previousData: {},
    metadata: { source: 'text-service', pipeline: 'summary-v2' },
    createdBy: '60000000-0000-0000-0000-000000000000',
    createdAt: new Date('2025-12-15T10:35:00Z'),
  },
  // 9. Doctor edits summary (version 2)
  {
    id: SEED_AUDIT_LOG_IDS.EDIT_SUMMARY,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.DOCTOR,
    responsibleIp: '10.0.2.50',
    resourceType: 'ContextItem' as const,
    resourceId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
    correlationId: `${CORRELATION_PREFIX}-summary-001`,
    causationId: `${CORRELATION_PREFIX}-summary-001`,
    action: 'UPDATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: {
      contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
      versionNumber: 2,
      changeReason: 'Medication dosage corrected and ICD-10 code added',
      changeSource: 'manual',
    },
    previousData: {
      versionNumber: 1,
      changeSource: 'ai_model_v2',
    },
    metadata: { source: 'sdk', sdkVersion: '2.1.0' },
    createdBy: SEED_USER_IDS.DOCTOR,
    createdAt: new Date('2025-12-15T10:45:00Z'),
  },
  // 10. Doctor reopens consultation
  {
    id: SEED_AUDIT_LOG_IDS.REOPEN_CONSULTATION,
    tenantId: SEED_TENANT_ID,
    responsibleUserId: SEED_USER_IDS.DOCTOR,
    responsibleIp: '10.0.2.50',
    resourceType: 'Consultation' as const,
    resourceId: SEED_CONSULTATION_IDS.GEN_REOPENED,
    correlationId: `${CORRELATION_PREFIX}-consult-reopen-001`,
    causationId: `${CORRELATION_PREFIX}-consult-001`,
    action: 'CREATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: {
      consultationId: SEED_CONSULTATION_IDS.GEN_REOPENED,
      parentConsultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
      reason: 'addendum',
      visitType: 'REVISIT',
      status: 'OPEN',
    },
    previousData: {},
    metadata: { source: 'sdk', sdkVersion: '2.1.0' },
    createdBy: SEED_USER_IDS.DOCTOR,
    createdAt: new Date('2026-01-05T09:00:00Z'),
  },
];

export const CUSTOMER_TENANT_AUDIT_LOGS = [
  // ── ArcaAI tenant ───────────────────────────────────────────────────
  {
    id: SEED_AUDIT_LOG_IDS.ARCAAI_LOGIN_ADMIN,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    responsibleUserId: SEED_USER_IDS.ARCAAI_ADMIN,
    responsibleIp: '10.1.0.10',
    resourceType: 'User' as const,
    resourceId: SEED_USER_IDS.ARCAAI_ADMIN,
    correlationId: `${CORRELATION_PREFIX}-arcaai-login-001`,
    causationId: null,
    action: 'LOGIN' as const,
    eventType: 'AUTHENTICATION',
    success: true,
    data: { username: 'arcaai_admin', loginMethod: 'password' },
    previousData: {},
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
    createdAt: new Date('2026-02-21T09:00:00Z'),
  },
  {
    id: SEED_AUDIT_LOG_IDS.ARCAAI_CREATE_DEPT,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    responsibleUserId: SEED_USER_IDS.ARCAAI_ADMIN,
    responsibleIp: '10.1.0.10',
    resourceType: 'Tenant' as const,
    resourceId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    correlationId: `${CORRELATION_PREFIX}-arcaai-dept-001`,
    causationId: null,
    action: 'CREATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: { entity: 'Department', departmentCode: 'GEN', departmentName: 'General Medicine' },
    previousData: {},
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
    createdAt: new Date('2026-02-21T09:15:00Z'),
  },
  {
    id: SEED_AUDIT_LOG_IDS.ARCAAI_CREATE_CONSULTATION,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    responsibleUserId: SEED_USER_IDS.ARCAAI_DOCTOR,
    responsibleIp: '10.1.0.50',
    resourceType: 'Consultation' as const,
    resourceId: SEED_CONSULTATION_IDS.ARCAAI_GEN_NEW,
    correlationId: `${CORRELATION_PREFIX}-arcaai-consult-001`,
    causationId: null,
    action: 'CREATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: { consultationId: SEED_CONSULTATION_IDS.ARCAAI_GEN_NEW, visitType: 'NEW_PATIENT', status: 'OPEN' },
    previousData: {},
    metadata: { source: 'sdk', sdkVersion: '2.1.0' },
    createdBy: SEED_USER_IDS.ARCAAI_DOCTOR,
    createdAt: new Date('2026-02-21T10:00:00Z'),
  },
  {
    id: SEED_AUDIT_LOG_IDS.ARCAAI_UPDATE_SETTINGS,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    responsibleUserId: SEED_USER_IDS.ARCAAI_ADMIN,
    responsibleIp: '10.1.0.10',
    resourceType: 'GlobalSetting' as const,
    resourceId: null,
    correlationId: `${CORRELATION_PREFIX}-arcaai-settings-001`,
    causationId: null,
    action: 'UPDATE' as const,
    eventType: 'RESOURCE',
    success: true,
    data: { key: 'max-concurrent-sessions', oldValue: '10', newValue: '20' },
    previousData: { value: '10' },
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
    createdAt: new Date('2026-02-22T11:00:00Z'),
  },
  {
    id: SEED_AUDIT_LOG_IDS.ARCAAI_ASSIGN_ROLE,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    responsibleUserId: SEED_USER_IDS.ARCAAI_ADMIN,
    responsibleIp: '10.1.0.10',
    resourceType: 'UserRoleAssignment' as const,
    resourceId: null,
    correlationId: `${CORRELATION_PREFIX}-arcaai-rbac-001`,
    causationId: null,
    action: 'CREATE' as const,
    eventType: 'AUTHORIZATION',
    success: true,
    data: { userId: SEED_USER_IDS.ARCAAI_DOCTOR, roleId: SEED_ROLE_IDS.DOCTOR, roleName: 'DOCTOR' },
    previousData: {},
    metadata: { source: 'admin-panel' },
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
    createdAt: new Date('2026-02-21T09:30:00Z'),
  },
];

export const seedAuditLog = async (client: CorePrismaClient) => {
  console.log('Seeding audit log entries...');

  const allEntries = [...DEFAULT_AUDIT_LOGS, ...CUSTOMER_TENANT_AUDIT_LOGS];

  for (const entry of allEntries) {
    await client.auditLog.upsert({
      where: { id: entry.id },
      update: entry,
      create: entry,
    });
  }

  console.log(
    `  Seeded ${allEntries.length} audit log entries (${DEFAULT_AUDIT_LOGS.length} global + ${CUSTOMER_TENANT_AUDIT_LOGS.length} customer-tenant)`,
  );
};

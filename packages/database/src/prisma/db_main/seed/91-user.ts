import * as bcryptjs from 'bcryptjs';
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import {
    SYSTEM_USER_ID,
    SEED_TENANT_ID,
    SEED_CUSTOMER_TENANT_IDS,
    SEED_USER_IDS,
    SEED_DEPARTMENT_IDS,
} from './00-constants';

/**
 * User Seed Data
 *
 * Creates default users with role assignments for the HOPE platform.
 *
 * User Structure:
 * - username: Unique login identifier
 * - password: Hashed password (default: password123)
 * - roleNames: Array of role names to assign
 * - tenantId: Tenant scope (null = global)
 * - profile: User profile information
 */

export const seedUser = async (client: CorePrismaClient) => {
    console.log('Seeding users...');

    // Get all roles
    const roles = await client.role.findMany();
    const roleMap = new Map(roles.map(r => [r.name, r]));

    // Function to hash passwords
    const hashPassword = async (password: string): Promise<string> => {
        const saltRounds = 10;
        return bcryptjs.hash(password, saltRounds);
    };

    // Default password for all seeded users
    const defaultPassword = await hashPassword('password123');

    // =========================================================================
    // Define users with their roles
    // =========================================================================
    // This seed creates users for the current healthcare-focused RBAC system.
    // Available roles (7 total):
    // - SUPER_ADMIN: Full system access (GLOBAL scope)
    // - TENANT_ADMIN: Full tenant management
    // - DOCTOR: Clinical role, owns consultations
    // - NURSE: Read-only clinical support
    // - SERVICE_ACCOUNT: API/integration access
    // - DEPARTMENT_HEAD: Extends DOCTOR with delegation
    // - SENIOR_NURSE: Extends NURSE with broader access
    // =========================================================================

    const users = [
        // =================================================================
        // SYSTEM ACCOUNT
        // =================================================================
        {
            id: SYSTEM_USER_ID,
            username: '__system__',
            password: null,
            isServiceAccount: true,
            roleNames: ['SERVICE_ACCOUNT'],
            tenantId: null,
            profile: {
                firstName: 'System',
                lastName: 'Account',
                email: 'system@arcaai.internal',
                phone: null,
            },
            tags: ['system', 'service'],
            lastLoginAt: null,
            lastActiveAt: null,
        },

        // =================================================================
        // SYSTEM ADMINISTRATORS
        // =================================================================
        {
            id: SEED_USER_IDS.SUPER_ADMIN,
            username: 'super_admin',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['SUPER_ADMIN'],
            tenantId: null, // Global access across all tenants
            profile: {
                firstName: 'Super',
                lastName: 'Admin',
                email: 'super.admin@example.com',
                phone: '+1234567890',
            },
            tags: ['admin', 'system'],
            lastLoginAt: new Date(),
            lastActiveAt: new Date(),
        },
        {
            id: SEED_USER_IDS.TENANT_ADMIN,
            username: 'tenant_admin',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['TENANT_ADMIN'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Tenant',
                lastName: 'Admin',
                email: 'tenant.admin@example.com',
                phone: '+1234567891',
            },
            tags: ['admin', 'tenant'],
            lastLoginAt: null,
            lastActiveAt: null,
        },

        // =================================================================
        // HEALTHCARE ROLES - Primary test users
        // =================================================================
        {
            id: SEED_USER_IDS.DOCTOR,
            username: 'doctor',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'John',
                lastName: 'Smith',
                email: 'doctor.smith@example.com',
                phone: '+1234567810',
            },
            tags: ['clinical', 'doctor'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.DOCTOR2,
            username: 'doctor2',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Jane',
                lastName: 'Doe',
                email: 'doctor.doe@example.com',
                phone: '+1234567811',
            },
            tags: ['clinical', 'doctor'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.DEPT_HEAD,
            username: 'department_head',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DEPARTMENT_HEAD'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Michael',
                lastName: 'Johnson',
                email: 'dept.head@example.com',
                phone: '+1234567812',
            },
            tags: ['clinical', 'doctor', 'department-head'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.NURSE,
            username: 'nurse',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['NURSE'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Sarah',
                lastName: 'Williams',
                email: 'nurse.williams@example.com',
                phone: '+1234567813',
            },
            tags: ['clinical', 'nurse'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.SENIOR_NURSE,
            username: 'senior_nurse',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['SENIOR_NURSE'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Emily',
                lastName: 'Brown',
                email: 'senior.nurse@example.com',
                phone: '+1234567814',
            },
            tags: ['clinical', 'nurse', 'senior'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.NURSE_CARD,
            username: 'nurse_card',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['NURSE'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Tom',
                lastName: 'Brown',
                email: 'nurse.brown@example.com',
                phone: '+1234567819',
            },
            tags: ['clinical', 'nurse', 'cardiology'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.NURSE_MED,
            username: 'nurse_med',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['NURSE'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Amy',
                lastName: 'Lee',
                email: 'nurse.lee@example.com',
                phone: '+1234567820',
            },
            tags: ['clinical', 'nurse', 'medicine'],
            lastLoginAt: null,
            lastActiveAt: null,
        },

        // =================================================================
        // HEALTHCARE ROLES - Department-specific doctors
        // =================================================================
        {
            id: SEED_USER_IDS.DOCTOR_SURGERY,
            username: 'doctor_surgery',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Raj',
                lastName: 'Patel',
                email: 'doctor.patel@example.com',
                phone: '+1234567815',
            },
            tags: ['clinical', 'doctor', 'surgery'],
            lastLoginAt: new Date('2026-02-20T08:00:00Z'),
            lastActiveAt: new Date('2026-02-20T16:30:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_NEURO,
            username: 'doctor_neuro',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Lisa',
                lastName: 'Chen',
                email: 'doctor.chen@example.com',
                phone: '+1234567816',
            },
            tags: ['clinical', 'doctor', 'neurology'],
            lastLoginAt: new Date('2026-02-21T09:00:00Z'),
            lastActiveAt: new Date('2026-02-21T17:00:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_PEDS,
            username: 'doctor_peds',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Maria',
                lastName: 'Garcia',
                email: 'doctor.garcia@example.com',
                phone: '+1234567817',
            },
            tags: ['clinical', 'doctor', 'pediatrics'],
            lastLoginAt: new Date('2026-02-22T07:30:00Z'),
            lastActiveAt: new Date('2026-02-22T15:00:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_ER,
            username: 'doctor_er',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'James',
                lastName: 'Wilson',
                email: 'doctor.wilson@example.com',
                phone: '+1234567818',
            },
            tags: ['clinical', 'doctor', 'emergency'],
            lastLoginAt: new Date('2026-02-23T22:00:00Z'),
            lastActiveAt: new Date('2026-02-24T06:00:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_BREN,
            username: 'doctor_bren',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Priya',
                lastName: 'Sharma',
                email: 'doctor.sharma@example.com',
                phone: '+1234567821',
            },
            tags: ['clinical', 'doctor', 'breast-endocrine'],
            lastLoginAt: new Date('2026-02-24T08:00:00Z'),
            lastActiveAt: new Date('2026-02-24T16:00:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_RHEUM,
            username: 'doctor_rheum',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'David',
                lastName: 'Park',
                email: 'doctor.park@example.com',
                phone: '+1234567822',
            },
            tags: ['clinical', 'doctor', 'rheumatology'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.DOCTOR_HEME,
            username: 'doctor_heme',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Aisha',
                lastName: 'Khan',
                email: 'doctor.khan@example.com',
                phone: '+1234567823',
            },
            tags: ['clinical', 'doctor', 'hematology'],
            lastLoginAt: new Date('2026-02-23T09:00:00Z'),
            lastActiveAt: new Date('2026-02-23T17:30:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_DERM,
            username: 'doctor_derm',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Carlos',
                lastName: 'Rivera',
                email: 'doctor.rivera@example.com',
                phone: '+1234567824',
            },
            tags: ['clinical', 'doctor', 'dermatology'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.DOCTOR_DIET,
            username: 'doctor_diet',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Mei',
                lastName: 'Lin',
                email: 'doctor.lin@example.com',
                phone: '+1234567825',
            },
            tags: ['clinical', 'doctor', 'dietetics'],
            lastLoginAt: new Date('2026-02-22T10:00:00Z'),
            lastActiveAt: new Date('2026-02-22T18:00:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_NEPH,
            username: 'doctor_neph',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Omar',
                lastName: 'Hassan',
                email: 'doctor.hassan@example.com',
                phone: '+1234567826',
            },
            tags: ['clinical', 'doctor', 'nephrology'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.DOCTOR_SONC,
            username: 'doctor_sonc',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Elena',
                lastName: 'Volkov',
                email: 'doctor.volkov@example.com',
                phone: '+1234567827',
            },
            tags: ['clinical', 'doctor', 'surgical-oncology'],
            lastLoginAt: new Date('2026-02-21T07:00:00Z'),
            lastActiveAt: new Date('2026-02-21T15:30:00Z'),
        },
        {
            id: SEED_USER_IDS.DOCTOR_MED,
            username: 'doctor_med',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['DOCTOR'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Thomas',
                lastName: 'Wright',
                email: 'doctor.wright@example.com',
                phone: '+1234567828',
            },
            tags: ['clinical', 'doctor', 'medicine'],
            lastLoginAt: new Date('2026-02-24T08:30:00Z'),
            lastActiveAt: new Date('2026-02-24T17:00:00Z'),
        },

        // =================================================================
        // MULTI-TENANT ADMINS
        // =================================================================
        {
            id: SEED_USER_IDS.ARCAAI_ADMIN,
            username: 'arcaai_admin',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['TENANT_ADMIN'],
            tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
            profile: {
                firstName: 'ArcaAI',
                lastName: 'Administrator',
                email: 'admin@arcaai.com',
                phone: '+6591234567',
            },
            tags: ['admin', 'tenant', 'arcaai'],
            lastLoginAt: new Date('2026-02-24T10:00:00Z'),
            lastActiveAt: new Date('2026-02-24T10:00:00Z'),
        },
        {
            id: SEED_USER_IDS.FOURBITS_ADMIN,
            username: 'fourbits_admin',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['TENANT_ADMIN'],
            tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
            profile: {
                firstName: '4bits',
                lastName: 'Administrator',
                email: 'admin@4bits.io',
                phone: '+6581234567',
            },
            tags: ['admin', 'tenant', 'fourbits'],
            lastLoginAt: null,
            lastActiveAt: null,
        },
        {
            id: SEED_USER_IDS.MUMBAI_ADMIN,
            username: 'mumbai_admin',
            password: defaultPassword,
            isServiceAccount: false,
            roleNames: ['TENANT_ADMIN'],
            tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
            profile: {
                firstName: 'Mumbai',
                lastName: 'Administrator',
                email: 'admin@mumbaihospital.in',
                phone: '+912212345678',
            },
            tags: ['admin', 'tenant', 'mumbai'],
            lastLoginAt: null,
            lastActiveAt: null,
        },

        // =================================================================
        // SERVICE ACCOUNTS
        // =================================================================
        {
            id: SEED_USER_IDS.SERVICE_ACCOUNT,
            username: 'service_account',
            password: defaultPassword,
            isServiceAccount: true,
            roleNames: ['SERVICE_ACCOUNT'],
            tenantId: SEED_TENANT_ID,
            profile: {
                firstName: 'Integration',
                lastName: 'Service',
                email: 'service@example.com',
                phone: null,
            },
            tags: ['service', 'integration'],
            lastLoginAt: null,
            lastActiveAt: null,
        },

    ];

    // Create users and related records
    for (const userData of users) {
        try {
            // 1. Create User record
            const user = await client.user.upsert({
                where: { id: userData.id },
                update: {
                    username: userData.username,
                    password: userData.password ?? defaultPassword,
                    isServiceAccount: userData.isServiceAccount,
                    tags: userData.tags,
                    lastLoginAt: userData.lastLoginAt,
                    lastActiveAt: userData.lastActiveAt,
                },
                create: {
                    id: userData.id,
                    username: userData.username,
                    password: userData.password ?? defaultPassword,
                    isServiceAccount: userData.isServiceAccount,
                    tags: userData.tags,
                    lastLoginAt: userData.lastLoginAt,
                    lastActiveAt: userData.lastActiveAt,
                },
            });

            // 2. Create UserProfile
            await client.userProfile.upsert({
                where: { userId: user.id },
                update: {
                    firstName: userData.profile.firstName,
                    lastName: userData.profile.lastName,
                    email: userData.profile.email,
                    phone: userData.profile.phone,
                },
                create: {
                    userId: user.id,
                    firstName: userData.profile.firstName,
                    lastName: userData.profile.lastName,
                    email: userData.profile.email,
                    phone: userData.profile.phone,
                },
            });

            // 3. Assign Roles (new schema: 1:1 relationship with roleId)
            for (const roleName of userData.roleNames) {
                const role = roleMap.get(roleName);
                if (role) {
                    // Check if assignment already exists
                    const existingAssignment = await client.userRoleAssignment.findFirst({
                        where: {
                            userId: user.id,
                            roleId: role.id,
                            tenantId: userData.tenantId,
                        },
                    });

                    if (!existingAssignment) {
                        // Let Prisma auto-generate the ID to avoid conflicts
                        await client.userRoleAssignment.create({
                            data: {
                                userId: user.id,
                                roleId: role.id,
                                tenantId: userData.tenantId,
                            },
                        });
                        console.log(`  Assigned role "${roleName}" to user "${userData.username}"`);
                    }
                } else {
                    console.warn(`  Warning: Role "${roleName}" not found for user "${userData.username}"`);
                }
            }

            console.log(`Created user: ${userData.username}`);
        } catch (error) {
            console.error(`Error creating user ${userData.username}:`, error);
        }
    }

    // =========================================================================
    // User Settings - General UI preferences
    // =========================================================================
    const generalUserSettings = [
        {
            id: '80000000-0000-0000-0000-000000000001',
            userId: SEED_USER_IDS.SUPER_ADMIN,
            name: 'Theme Preference',
            key: 'theme',
            value: 'dark',
            dataType: ValueType.String,
            namespace: 'ui',
        },
    ];

    // Create general user settings
    for (const setting of generalUserSettings) {
        await client.userSettings.upsert({
            where: { id: setting.id },
            update: {
                name: setting.name,
                key: setting.key,
                value: setting.value,
                dataType: setting.dataType,
                namespace: setting.namespace,
            },
            create: {
                id: setting.id,
                userId: setting.userId,
                name: setting.name,
                key: setting.key,
                value: setting.value,
                dataType: setting.dataType,
                namespace: setting.namespace,
            },
        });
    }

    // =========================================================================
    // Tenant-wide Default Pipeline (GlobalSettings)
    // =========================================================================
    console.log('Seeding tenant-wide default pipeline setting...');

    await client.globalSetting.upsert({
        where: {
            GlobalSetting_tenantId_name_key_unique: {
                tenantId: SEED_TENANT_ID,
                name: 'stt-pipeline',
                key: 'default-stt-pipeline',
            },
        },
        update: {
            value: '81000000-0000-0000-0001-000000000001',
            description: 'Default ASR pipeline for all doctors when using remote workflow mode',
        },
        create: {
            id: '82000000-0000-0000-0002-000000000100',
            tenantId: SEED_TENANT_ID,
            namespace: 'arcaai-sdk',
            name: 'stt-pipeline',
            key: 'default-stt-pipeline',
            value: '81000000-0000-0000-0001-000000000001',
            defaultValue: '81000000-0000-0000-0001-000000000001',
            dataType: ValueType.String,
            description: 'Default ASR pipeline for all doctors when using remote workflow mode',
        },
    });
    console.log('  Created tenant-wide default pipeline setting');

    // =========================================================================
    // SDK User Preferences - Workflow-Oriented Structure
    // Namespace: 'arcaai-sdk' (doctor-controlled preferences)
    // Namespace: 'arcaai-admin' (admin-controlled pipeline assignments)
    // =========================================================================
    console.log('Seeding SDK user preferences...');

    const sdkUserPreferences = [
        // =====================================================================
        // Doctor (John Smith) - Local workflow
        // Selects individual models for browser-side processing
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000001',
            userId: SEED_USER_IDS.DOCTOR,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000002',
            userId: SEED_USER_IDS.DOCTOR,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000003',
            userId: SEED_USER_IDS.DOCTOR,
            name: 'SDK Preference: dnaStyleId',
            key: 'dnaStyleId',
            value: 'clinical-concise-en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000004',
            userId: SEED_USER_IDS.DOCTOR,
            name: 'SDK Preference: localConfig',
            key: 'localConfig',
            value: JSON.stringify({
                noiseCancellation: { modelId: 'rnnoise', level: 'high' },
                stt: { modelId: 'whisper-large-v3' },
                vad: { modelId: 'silero-vad-v5', sensitivity: 0.6 },
                ner: { modelId: 'biomedical', autoExtract: true },
                diarization: { enabled: true, autoEnroll: true },
            }),
            dataType: ValueType.Json,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000005',
            userId: SEED_USER_IDS.DOCTOR,
            name: 'SDK Preference: custom',
            key: 'custom',
            value: JSON.stringify({
                autoSaveInterval: 30000,
                showWaveform: true,
                defaultTemplate: 'soap-note',
            }),
            dataType: ValueType.Json,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Doctor2 (Jane Doe) - Remote workflow
        // Uses admin-assigned pipeline, Thai language
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000011',
            userId: SEED_USER_IDS.DOCTOR2,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'remote',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000012',
            userId: SEED_USER_IDS.DOCTOR2,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'th',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000013',
            userId: SEED_USER_IDS.DOCTOR2,
            name: 'SDK Preference: dnaStyleId',
            key: 'dnaStyleId',
            value: 'clinical-detailed-th',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Department Head (Michael Johnson) - Local workflow, power user
        // All features enabled with custom shortcuts
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000021',
            userId: SEED_USER_IDS.DEPT_HEAD,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000022',
            userId: SEED_USER_IDS.DEPT_HEAD,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000023',
            userId: SEED_USER_IDS.DEPT_HEAD,
            name: 'SDK Preference: localConfig',
            key: 'localConfig',
            value: JSON.stringify({
                noiseCancellation: { modelId: 'rnnoise', level: 'high' },
                stt: { modelId: 'whisper-large-v3' },
                vad: { modelId: 'silero-vad-v5', sensitivity: 0.7 },
                ner: { modelId: 'biomedical', autoExtract: true },
                diarization: { enabled: true, autoEnroll: true },
            }),
            dataType: ValueType.Json,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000024',
            userId: SEED_USER_IDS.DEPT_HEAD,
            name: 'SDK Preference: custom',
            key: 'custom',
            value: JSON.stringify({
                autoSaveInterval: 15000,
                showWaveform: true,
                showSpeakerLabels: true,
                defaultTemplate: 'comprehensive-note',
                enableShortcuts: true,
            }),
            dataType: ValueType.Json,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Raj Patel (Surgery) - Remote workflow, English
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000041',
            userId: SEED_USER_IDS.DOCTOR_SURGERY,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'remote',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000042',
            userId: SEED_USER_IDS.DOCTOR_SURGERY,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000043',
            userId: SEED_USER_IDS.DOCTOR_SURGERY,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.SURG,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Lisa Chen (Neurology) - Local workflow, English
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000051',
            userId: SEED_USER_IDS.DOCTOR_NEURO,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000052',
            userId: SEED_USER_IDS.DOCTOR_NEURO,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000053',
            userId: SEED_USER_IDS.DOCTOR_NEURO,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.NEUR,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Maria Garcia (Pediatrics) - Local workflow, Spanish
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000061',
            userId: SEED_USER_IDS.DOCTOR_PEDS,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000062',
            userId: SEED_USER_IDS.DOCTOR_PEDS,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'es',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000063',
            userId: SEED_USER_IDS.DOCTOR_PEDS,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.PEDS,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. James Wilson (Emergency) - Remote workflow, English
        // =====================================================================
        {
            id: '81000000-0000-0000-0000-000000000071',
            userId: SEED_USER_IDS.DOCTOR_ER,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'remote',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000072',
            userId: SEED_USER_IDS.DOCTOR_ER,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '81000000-0000-0000-0000-000000000073',
            userId: SEED_USER_IDS.DOCTOR_ER,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.ER,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Priya Sharma (Breast & Endocrine) - Local workflow, English
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000001',
            userId: SEED_USER_IDS.DOCTOR_BREN,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000002',
            userId: SEED_USER_IDS.DOCTOR_BREN,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000003',
            userId: SEED_USER_IDS.DOCTOR_BREN,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.BREN,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. David Park (Rheumatology) - Remote workflow, English
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000011',
            userId: SEED_USER_IDS.DOCTOR_RHEUM,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'remote',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000012',
            userId: SEED_USER_IDS.DOCTOR_RHEUM,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000013',
            userId: SEED_USER_IDS.DOCTOR_RHEUM,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.RHEUM,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Aisha Khan (Hematology) - Local workflow, English
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000021',
            userId: SEED_USER_IDS.DOCTOR_HEME,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000022',
            userId: SEED_USER_IDS.DOCTOR_HEME,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000023',
            userId: SEED_USER_IDS.DOCTOR_HEME,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.HEME,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Carlos Rivera (Dermatology) - Remote workflow, Spanish
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000031',
            userId: SEED_USER_IDS.DOCTOR_DERM,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'remote',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000032',
            userId: SEED_USER_IDS.DOCTOR_DERM,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'es',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000033',
            userId: SEED_USER_IDS.DOCTOR_DERM,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.DERM,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Mei Lin (Dietetics) - Local workflow, Chinese
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000041',
            userId: SEED_USER_IDS.DOCTOR_DIET,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000042',
            userId: SEED_USER_IDS.DOCTOR_DIET,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'zh',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000043',
            userId: SEED_USER_IDS.DOCTOR_DIET,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.DIET,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Omar Hassan (Nephrology) - Remote workflow, Arabic
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000051',
            userId: SEED_USER_IDS.DOCTOR_NEPH,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'remote',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000052',
            userId: SEED_USER_IDS.DOCTOR_NEPH,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'ar',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000053',
            userId: SEED_USER_IDS.DOCTOR_NEPH,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.NEPH,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Elena Volkov (Surgical Oncology) - Local workflow, Russian
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000061',
            userId: SEED_USER_IDS.DOCTOR_SONC,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000062',
            userId: SEED_USER_IDS.DOCTOR_SONC,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'ru',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000063',
            userId: SEED_USER_IDS.DOCTOR_SONC,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.SONC,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },

        // =====================================================================
        // Dr. Thomas Wright (Medicine) - Local workflow, English
        // =====================================================================
        {
            id: '84000000-0000-0000-0000-000000000071',
            userId: SEED_USER_IDS.DOCTOR_MED,
            name: 'SDK Preference: workflowMode',
            key: 'workflowMode',
            value: 'local',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000072',
            userId: SEED_USER_IDS.DOCTOR_MED,
            name: 'SDK Preference: language',
            key: 'language',
            value: 'en',
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
        {
            id: '84000000-0000-0000-0000-000000000073',
            userId: SEED_USER_IDS.DOCTOR_MED,
            name: 'SDK Preference: primaryDepartmentId',
            key: 'primaryDepartmentId',
            value: SEED_DEPARTMENT_IDS.MED,
            dataType: ValueType.String,
            namespace: 'arcaai-sdk',
        },
    ];

    // Create SDK user preferences
    for (const pref of sdkUserPreferences) {
        await client.userSettings.upsert({
            where: { id: pref.id },
            update: {
                name: pref.name,
                key: pref.key,
                value: pref.value,
                dataType: pref.dataType,
                namespace: pref.namespace,
            },
            create: {
                id: pref.id,
                userId: pref.userId,
                name: pref.name,
                key: pref.key,
                value: pref.value,
                dataType: pref.dataType,
                namespace: pref.namespace,
            },
        });
    }
    console.log(`  Created ${sdkUserPreferences.length} SDK user preferences`);

    // =========================================================================
    // Admin Pipeline Assignments (namespace: 'arcaai-admin')
    // Per-user pipeline overrides assigned by administrators
    // =========================================================================
    console.log('Seeding admin pipeline assignments...');

    const adminPipelineAssignments = [
        // Jane Doe gets assigned the Turbo pipeline by admin
        {
            id: '81000000-0000-0000-0000-000000000031',
            userId: SEED_USER_IDS.DOCTOR2,
            name: 'Admin: Assigned Pipeline',
            key: 'assigned-pipeline',
            value: '81000000-0000-0000-0001-000000000002', // Turbo Pipeline
            dataType: ValueType.String,
            namespace: 'arcaai-admin',
        },
    ];

    for (const assignment of adminPipelineAssignments) {
        await client.userSettings.upsert({
            where: { id: assignment.id },
            update: {
                name: assignment.name,
                key: assignment.key,
                value: assignment.value,
                dataType: assignment.dataType,
                namespace: assignment.namespace,
            },
            create: {
                id: assignment.id,
                userId: assignment.userId,
                name: assignment.name,
                key: assignment.key,
                value: assignment.value,
                dataType: assignment.dataType,
                namespace: assignment.namespace,
            },
        });
    }
    console.log(`  Created ${adminPipelineAssignments.length} admin pipeline assignments`)

    console.log('User seeding completed successfully');
    return { success: true, count: users.length };
};

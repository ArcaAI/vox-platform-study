import type { LucideIcon } from 'lucide-react';
import { Activity, Building2, FolderTree, History, KeyRound, Radio, ScrollText, Settings, Shield, Users } from 'lucide-react';

export interface NavItem {
    label: string;
    to: string;
    icon: LucideIcon;
    /** Short caption shown under the section, mirrors TASK-371 pillars. */
    description?: string;
}

export interface NavSection {
    /** One of the TASK-371 "5 pillars" groupings. */
    title: string;
    items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
    {
        title: 'Multi-Tenancy',
        items: [{ label: 'Tenants', to: '/tenants', icon: Building2, description: 'Organizations on the platform' }],
    },
    {
        title: 'Identity & Access',
        items: [
            { label: 'Users', to: '/users', icon: Users, description: 'People and service accounts' },
            { label: 'Roles & Policies', to: '/roles', icon: Shield, description: 'RBAC and CASL policies' },
            { label: 'API Keys', to: '/api-keys', icon: KeyRound, description: 'Programmatic credentials' },
        ],
    },
    {
        title: 'Clinical Operations',
        items: [
            { label: 'Consultation History', to: '/history', icon: History, description: 'Context timeline by consultation' },
            { label: 'Live Session', to: '/live', icon: Radio, description: 'Realtime transcript capture' },
            { label: 'Departments & Prompts', to: '/departments', icon: FolderTree, description: 'Departments and prompt templates' },
        ],
    },
    {
        title: 'Observability',
        items: [
            { label: 'Audit Log', to: '/audit-log', icon: ScrollText, description: 'Tenant activity, keyset-paginated' },
            { label: 'System Health', to: '/system-health', icon: Activity, description: 'Service status and monitoring' },
        ],
    },
    {
        title: 'Platform',
        items: [{ label: 'Settings', to: '/settings', icon: Settings, description: 'Global and personal settings' }],
    },
];

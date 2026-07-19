import type { Metadata } from 'next';
import { ToolsMcpScreen } from '@/features/tools-mcp/components/tools-mcp-screen';

export const metadata: Metadata = { title: 'Tools & MCP' };

/** TASK-512 screen 5 — read-only agentic tool / MCP registry (tier 10-19). */
export default function ToolsMcpPage() {
    return <ToolsMcpScreen />;
}

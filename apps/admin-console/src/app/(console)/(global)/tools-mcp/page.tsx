import type { Metadata } from 'next';
import { ToolsMcpScreen } from '@/features/tools-mcp/components/tools-mcp-screen';

export const metadata: Metadata = { title: 'Tools & MCP' };

/** screen 5 — agentic tool / MCP registry, full CRUD under If-Match OCC (tier 10-19). */
export default function ToolsMcpPage() {
    return <ToolsMcpScreen />;
}

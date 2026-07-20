"""MCP external-tools client.

The harness calls READ-ONLY MCP tools (streamable-HTTP transport) via the official
``mcp`` python SDK. The SDK is an OPTIONAL extra (``harness[mcp-tools]``) imported
LAZILY, so the base install / hermetic test suite need not carry it — the whole MCP
path is dormant unless a global admin enables it per tenant AND per server.
"""

from harness.tools.mcp_client import (
    McpClientError,
    McpToolClient,
    McpToolResult,
)

__all__ = [
    "McpClientError",
    "McpToolClient",
    "McpToolResult",
]

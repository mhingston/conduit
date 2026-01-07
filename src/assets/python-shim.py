# Python Shim for Conduit - Code Mode SDK
import asyncio

async def discover_mcp_tools(options=None):
    """Discover available MCP tools from the gateway."""
    # These functions are injected into the Python global scope by the executor
    res = await discover_mcp_tools_js(options)
    # Pyodide's JS proxy handles conversion broadly, but we might need to convert the tools list
    if hasattr(res, 'to_py'):
        data = res.to_py()
        return data.get('tools', []) if isinstance(data, dict) else []
    return []

async def _internal_call_tool(name, arguments):
    """Internal tool call function - used by generated SDK."""
    res = await call_mcp_tool_js(name, arguments)
    if hasattr(res, 'to_py'):
        return res.to_py()
    return res

# __CONDUIT_SDK_INJECTION__

<div align="center">
  <img src="./logo.png" alt="Conduit Logo" width="400"/>
</div>

# Conduit

<div align="center">

[![npm version](https://badge.fury.io/js/@mhingston5%2Fconduit.svg)](https://www.npmjs.com/package/@mhingston5/conduit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js Version](https://img.shields.io/badge/node-24-brightgreen.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)
[![Standard MCP Server](https://img.shields.io/badge/MCP-Server-blue.svg)](https://modelcontextprotocol.io/server)

</div>

## What is Conduit?

Conduit is a **secure Code Mode execution substrate** for [MCP](https://modelcontextprotocol.io/) agents. It functions as a **standard MCP server**, allowing native integration with clients like Claude Desktop or VS Code without extra adapters.

It lets agents:
- generate **real TypeScript or Python code**
- call tools via **language-native APIs** (`tools.github.createIssue()`)
- run that code in **isolated, resource-governed sandboxes**
- without exposing credentials or the host environment

Conduit is optimized for:
- [Code Mode](./docs/CODE_MODE.md) (not JSON tool calling)
- composable multi-tool execution
- strict safety, limits, and observability

## What Conduit Is Not

- ❌ A general-purpose script runner
- ❌ An LLM gateway or provider abstraction
- ❌ A plugin UI or agent framework
- ❌ A long-lived compute environment

Conduit executes **short-lived, isolated programs** with explicit limits.

---

## Installation

```bash
npm install @mhingston5/conduit
```

## 5-Minute Quick Start (Code Mode)

### 1. Start Conduit
```bash
pnpm install
# Build the project
npm run build
# Start the server
node dist/index.js
```

### 2. Register an upstream MCP server

Create a `conduit.yaml` in the root:
```yaml
upstreams:
  - id: github
    type: http
    url: "http://localhost:3000/mcp"
    # Or use local stdio for testing:
  - id: filesystem
    type: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

### 3. Execute TypeScript

Using any [MCP Client](https://modelcontextprotocol.io/clients) (Claude Desktop, etc.), call `mcp.executeTypeScript`:

```ts
// The agent writes this code:
const result = await tools.filesystem.list_allowed_directories();
console.log("Files:", result);
```

### 4. Result

Conduit runs the code, handles the tool call securely, and returns:

```json
{
  "stdout": "Files: ['/tmp']\n",
  "stderr": "",
  "exitCode": 0
}
```

---

## Example usage with VS Code

```json
{
  "mcpServers": {
    "conduit": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@mhingston5/conduit",
        "--stdio"
      ],
      "env": {}
    }
  }
}
```


---

## How It Works (High Level)

```
LLM → generates code  
↓  
Client → sends code to Conduit  
↓  
Conduit:
- injects a `tools.*` SDK
- enforces limits + allowlists
- runs code in an isolated runtime (Deno / Pyodide / Isolate)
↓  
Tools are called via the Gateway  
↓  
Results returned as stdout / stderr
```

For implementation details, see [Architecture](./docs/ARCHITECTURE.md).

---

## Security & Isolation Guarantees

Each execution:
- runs in a fresh sandbox (no state reuse)
- has strict CPU, memory, output, and log limits
- cannot access host credentials or filesystem
- can only call explicitly allowed tools
- is forcibly terminated on violation

**SSRF protection**:
- private IP ranges blocked
- DNS rebinding prevented
- IPv6-mapped IPv4 handled

**Secrets**:
- never injected into user code
- redacted from logs by default

See [Security](./docs/SECURITY.md) for the full threat model.

---

## Strict vs Permissive Tool Validation

By default, Conduit runs in **Permissive Mode** to allow easy exploration.

**Strict mode**:
- blocks unknown tools
- blocks tools without schemas
- enforces argument validation

**Recommended**:
- permissive mode for exploration
- strict mode for production agents

## Code Mode Prompting Guide

To get the most out of Conduit, you should guide your LLM (agent) to prefer multi-tool scripts over individual tool calls.

**Recommended System Prompt Additions:**
> You are equipped with a "Code Mode" execution environment via Conduit.
>
> - **Prefer `mcp.executeTypeScript`**: Use this for any task requiring multiple steps, data transformation, or logical branching.
> - **Use `tools.*` SDK**: Within your scripts, access all upstream tools via the `tools` namespace (e.g., `await tools.github.create_issue(...)`).
> - **Avoid JSON tool-calling overhead**: Instead of making 5 separate tool calls and waiting for 5 round-trips, write one script that orchestrates the entire operation.
> - **Data Transformation**: Perform loops, filters, and aggregations directly in your code rather than asking the user (or yourself) to process large datasets in the chat context.

Example of a high-efficiency prompt:
*"Scan the last 50 emails for invoices, total their amounts by currency, and create a single summary ticket in Jira if the total exceeds $1000."*

---

## Design Principles

- **Code over configuration**: Logic belongs in code, not yaml.
- **Isolation over reuse**: Every execution is fresh.
- **Explicit limits over best-effort**: Fail fast if limits are breached.
- **SDKs over RPC**: Agents should write code against libraries, not protocols.

---

## Advanced Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Internals, IPC, Executors
- [Security](./docs/SECURITY.md) - Threat model, specific mitigations
- [Code Mode Philosophy](./docs/CODE_MODE.md) - Why we generate code

## Note on Unix Sockets

When using Unix domain sockets (`path` in configuration), Conduit does not automatically `unlink` the socket file on startup. It is recommended to ensure the socket path is cleaned up by the deployment environment or startup script to avoid `EADDRINUSE` errors.

## License
MIT

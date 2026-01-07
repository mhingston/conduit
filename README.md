# Conduit

Conduit is a **Code Execution Substrate for MCP Agents**. Agents write code against typed APIs; tools are bindings, not RPC endpoints.

## Why Conduit?

Conduit solves the **"context exhaustion"** problem common in AI tool integration. Instead of exposing dozens of static tool definitions to an LLM (which consumes significant tokens), Conduit exposes only two tools: `executeTypeScript` and `executePython`.

The LLM avoids token overhead by:
1. **Executing Code:** The model writes code to handle complex logic.
2. **Dynamic Discovery:** Within the sandbox, the code dynamically discovers and calls required MCP tools.
3. **98% Token Reduction:** This "progressive disclosure" pattern can reduce the initial prompt size by up to 98%, preserving the context window for actual work.

## Code Mode Architecture

Conduit follows the [Code Mode](https://developers.cloudflare.com/agents/code-mode/) pattern:
- **LLMs generate code**, not tool calls
- **Tools are libraries**, not RPC endpoints
- **Execution is sandboxed** in Deno/Pyodide
- **Tool invocation** happens via typed SDK bindings

### Example (TypeScript)

```typescript
// Discover what's available
const schemas = await discoverMCPTools();

// Call tools via typed SDK
const issue = await tools.github.createIssue({
  title: "New feature",
  body: "Description here"
});

// Dynamic fallback for unknown tools
const result = await tools.$raw("custom__tool", { arg: "value" });
```

### Example (Python)

```python
# Discover what's available
schemas = await discover_mcp_tools()

# Call tools via typed SDK
issue = await tools.github.create_issue({"title": "New feature"})

# Dynamic fallback for unknown tools
result = await tools.raw("custom__tool", {"arg": "value"})
```

## Features

- **Secure Execution (TS/JS/Python):**
  - **TypeScript/JavaScript:** Executed in a Deno 2.x sandbox with strictly enforced CPU, Memory (RSS monitoring), and Output limits.
  - **In-Process JS:** Executed via **isolated-vm** (V8 isolates) for high-performance, low-overhead execution with strict memory/time limits.
  - **Python:** Executed via Pyodide in an isolated **Worker Thread**, with mandatory worker recycling (zero state leak) and resource capping.
  - **Tool Allowlisting:** Per-request authorization scope for tool discovery and execution.
- **Upstream Orchestration:** Unified access to multiple upstream MCP servers with automatic tool discovery and aggregate namespaces.
  - **SSRF Protection:** Strict validation of upstream URLs, including DNS resolution checks and **disabled HTTP redirects** to prevent bypass.
- **Resource Governance:**
  - **CPU Timeout:** Hard process termination (SIGKILL or worker.terminate) after configurable timeouts.
  - **Memory Limits:** Host-side RSS monitoring (Deno), worker isolation (Python), and isolate heap limits (isolated-vm).
  - **Output Capping:** Streams are truncated and processes terminated if output exceeds size limits (-32013).
- **Transport Flexibility:** Support for Unix Domain Sockets (UDS), Windows Named Pipes, and TCP.
- **Operational Excellence:**
  - **Distributed Tracing:** OpenTelemetry (OTEL) integration for distributed tracing and distributed context propagation.
  - **Structured Logging:** Pino logs with correlation IDs and automated PII/Secret redaction.
  - **Metrics:** Dedicated Ops server exposing metrics in standard **Prometheus text format**.
  - **Health Checks:** Aggregated health status including upstream status and Pyodide pool readiness.
  - **Concurrency:** Semaphore-based backpressure management.

## Architecture

Conduit is built with a modular architecture:
- **`src/core`**: Core services (Config, Logger, Concurrency, Ops, Request Dispatching).
- **`src/executors`**: Secure runtime environments for code execution.
- **`src/gateway`**: Upstream client management, auth (OAuth2/API Keys), and schema caching.
- **`src/transport`**: Network abstraction layer.

## Getting Started

### Prerequisites
- **Node.js**: v24.x LTS (pinned via `.npmrc`)
- **Deno**: v2.x (pinned via `.tool-versions`)
- **pnpm**: v10.x

### Installation
```bash
pnpm install
```

### Building
```bash
npm run build
```
This will bundle the TypeScript source and copy assets (shims) to the `dist` directory.

### Testing
```bash
npm test
```
Conduit includes a comprehensive suite of unit, integration, and contract tests (50+ tests total).

### Running
```bash
node dist/index.js
```
The server will start and listen on the configured port (default 3000) for JSON-RPC connections.

## Configuration

Configuration is managed via environment variables and validated with Zod.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Transport port | `3000` |
| `OPS_PORT` | Ops server port | `3001` |
| `NODE_ENV` | Environment (dev/prod) | `development` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `IPC_BEARER_TOKEN` | Bearer token for server authorization | `(generated)` |

Resource limits can be configured globally or overridden per request.

## License
MIT

# Conduit Architecture

Conduit is built with a modular architecture, designed to be secure, observable, and composable.

## Core Components

- **`src/core`**: Core services (Config, Logger, Concurrency, Ops, Request Dispatching).
- **`src/executors`**: Secure runtime environments for code execution.
- **`src/gateway`**: Upstream client management, auth (OAuth2/API Keys), and schema caching.
- **`src/transport`**: Network abstraction layer.
- **`src/sdk`**: SDK generation for typed tool bindings.

## Detailed Flow

1. **Client Request**: A client (like VS Code or Claude Desktop) sends a JSON-RPC request (`mcp_execute_typescript`).
2. **Transportation**: The request is received via `SocketTransport` (TCP/UDS/Pipe).
3. **Dispatch**: `RequestController` validates the request and session tokens.
4. **Tool Discovery**: `GatewayService` aggregates tools from all upstream MCP servers.
5. **SDK Generation**: The `ExecutionService` uses the `SDKGenerator` to generate a type-safe SDK (`tools.*`) based on discovered schemas.
6. **Execution**:
    - **Deno**: Spawns a Deno subprocess with limited permissions.
    - **Browser-style (In-Process)**: Uses `isolated-vm` for high-speed JS logic.
    - **Python**: Uses Pyodide in a worker thread.
7. **Result**: Stdout/stderr and return values are captured and returned to the client.

## IPC & Transport

Conduit supports multiple transports:
- **TCP**: Standard network sockets.
- **Unix Domain Sockets**: For local IPC.
- **Windows Named Pipes**: For local IPC on Windows.

## Schema Caching

To optimize performance, upstreams are polled for tool schemas, which are cached with a TTL. This prevents repeated network calls during high-frequency execution loops.

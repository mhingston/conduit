# Security & Isolation Guarantees

Conduit implements a defense-in-depth security model to ensure safe code execution.

## Isolation Guarantees

Each execution:
- runs in a **fresh sandbox** (no state reuse).
- has strict **CPU, memory, output, and log limits**.
- cannot access **host credentials or filesystem** (unless explicitly allowed via tools).
- can only call **explicitly allowed tools**.
- is **forcibly terminated** on violation.

## SSRF Protection

Conduit enforces strict Server-Side Request Forgery (SSRF) protections on upstreams:
- **Private IP ranges blocked** (unless explicitly allowed).
- **DNS rebinding prevented** by verifying IP resolution before connection.
- **IPv6-mapped IPv4** addresses are handled correctly.
- **HTTP Redirects** are visually disabled or strictly validated.

## Secrets Management

- **Injection**: Secrets are never injected into user code as environment variables (unless via specific secure tool config).
- **Redaction**: Logs are automatically scrubbed for known secrets and PII patterns.

## Authorization

- **Master Token**: Full access to all methods (set via `IPC_BEARER_TOKEN`).
- **Session Tokens**: Generated per-execution, restricted to `mcp_discover_tools` and `mcp_call_tool` only.
- **Tool Allowlisting**: Per-request scope limits which tools code can discover/call (e.g., `["github.*"]`).

## Runtime Security

- **Deno**: Uses OS-level sandbox permissions (`--allow-net`, `--allow-read` are restricted).
- **Pyodide**: Runs in a Worker Thread with no access to the main thread's DOM or context.
- **In-Process JS (isolated-vm)**: Uses V8 isolates for memory isolation but shares the host process.

## Production Hardening Recommendations

While Conduit provides robust application-level sandboxing, `isolated-vm` and Deno subprocesses still share the host kernel. For **multi-tenant** or **hostile** workloads, you must implement defense-in-depth by wrapping Conduit itself.

### Tiered Isolation Model

| Component | Protection Against | Vulnerable To |
|-----------|--------------------|---------------|
| **Conduit (Code)** | Logical errors, resource exhaustion, unauthorized tool use | Runtime/V8 escapes, Kernel exploits |
| **Container (Docker)** | Filesystem access, network enumeration | Kernel exploits, Container breakouts |
| **MicroVM (Firecracker/gVisor)** | Kernel exploits, complete system compromise | Hypervisor exploits (rare) |

**Recommendation:**
For production deployments executing untrusted code, deploy Conduit inside a **gVisor-backed container** or a **Firecracker MicroVM** (like AWS Fargate or Fly.io Machines). This prevents a V8/Deno escape from compromising the host infrastructure.

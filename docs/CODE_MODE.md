# Code Mode Philosophy

Conduit is built for **Code Mode**.

## What is Code Mode?

"Code Mode" is an architectural pattern for AI Agents where:
- **LLMs generate code**, not JSON tool calls.
- **Tools are libraries**, not RPC endpoints.
- **Execution is sandboxed**, not local.

Reference: [Cloudflare Code Mode](https://developers.cloudflare.com/agents/code-mode/)

## Why Code Mode?

### 1. Context Efficiency (98% Reduction)
Traditional "Tool Use" requires pasting typically huge JSON schemas for every available tool into the LLM system prompt.
In Code Mode, you paste **0 schemas**. The agent writes code to *discover* tools dynamically at runtime, or assumes standard SDK shapes.

### 2. Composition & Logic
Agent logic (loops, conditionals, retries, variable transformations) happens **in the code**, not in the LLM's context window.
- **Old Way**: LLM -> Tool Call -> LLM -> Tool Call -> LLM -> Result
- **Code Mode**: LLM -> `for (item in items) { await tool(item) }` -> Result

### 3. Safety
Because logic executes in a sandbox, you can enforce limits on loops, memory, and duration that are impossible to enforce on an LLM's token stream.

## Implementation in Conduit

Conduit provides:
1. **`mcp_execute_typescript` / `mcp_execute_python`**: The entry points.
2. **`tools.*` SDK**: A dynamically generated client injected into the runtime.
3. **Sandboxes**: Deno, Pyodide, and isolated-vm to run the code safely.

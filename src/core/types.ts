export enum ConduitError {
    InternalError = -32603,
    RequestTimeout = -32008,
    Forbidden = -32003,
    OutputLimitExceeded = -32013,
    MemoryLimitExceeded = -32009,
    LogLimitExceeded = -32014,
    ServerBusy = -32000,
}

export interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: any;
    auth?: {
        bearerToken: string;
    };
}

export interface JSONRPCResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export interface ToolPackage {
    id: string; // e.g., "github"
    description?: string;
    version?: string;
}

export interface ToolStub {
    id: string; // e.g., "github__create_issue"
    name: string; // e.g., "create_issue"
    description?: string;
}

export interface ToolManifest {
    version: string;
    tools: ToolStub[];
}

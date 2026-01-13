import Fastify from 'fastify';
import axios from 'axios';
import open from 'open';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';

export interface AuthOptions {
    authUrl?: string;
    tokenUrl?: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string;
    port?: number;
    mcpUrl?: string;
    usePkce?: boolean;
}

type DiscoveredOAuth = {
    authUrl: string;
    tokenUrl: string;
    scopes?: string[];
    resource?: string;
};

const AUTH_REQUEST_PAYLOAD = {
    jsonrpc: '2.0',
    id: 'conduit-auth',
    method: 'initialize',
    params: {
        clientInfo: {
            name: 'conduit-auth',
            version: '1.0.0',
        },
    },
};

function base64UrlEncode(buffer: Buffer): string {
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function createCodeVerifier(): string {
    return base64UrlEncode(crypto.randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
    return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

function parseResourceMetadataHeader(headerValue: string | string[] | undefined): string | null {
    if (!headerValue) return null;
    const header = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
    const match = header.match(/resource_metadata="([^"]+)"/i) || header.match(/resource_metadata=([^, ]+)/i);
    return match ? match[1] : null;
}

async function discoverOAuthFromMcp(mcpUrl: string): Promise<DiscoveredOAuth> {
    const attempts = [
        () => axios.get(mcpUrl, { validateStatus: () => true }),
        () => axios.post(mcpUrl, AUTH_REQUEST_PAYLOAD, { validateStatus: () => true }),
    ];

    let resourceMetadataUrl: string | null = null;
    for (const attempt of attempts) {
        const response = await attempt();
        resourceMetadataUrl = parseResourceMetadataHeader(response.headers['www-authenticate']);
        if (resourceMetadataUrl) break;
    }

    if (!resourceMetadataUrl) {
        throw new Error('Unable to discover OAuth metadata (missing WWW-Authenticate resource_metadata)');
    }

    const metadataResponse = await axios.get(resourceMetadataUrl);
    const metadata = metadataResponse.data as Record<string, any>;

    let authUrl = metadata.authorization_endpoint as string | undefined;
    let tokenUrl = metadata.token_endpoint as string | undefined;
    let scopes = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : undefined;
    const resource = typeof metadata.resource === 'string' ? metadata.resource : undefined;

    if (!authUrl || !tokenUrl) {
        const authServer = (Array.isArray(metadata.authorization_servers) && metadata.authorization_servers[0]) || metadata.issuer;
        if (!authServer) {
            throw new Error('OAuth metadata did not include authorization server info');
        }

        const asMetadataUrl = new URL('/.well-known/oauth-authorization-server', authServer).toString();
        const asMetadataResponse = await axios.get(asMetadataUrl);
        const asMetadata = asMetadataResponse.data as Record<string, any>;

        authUrl = authUrl || (asMetadata.authorization_endpoint as string | undefined);
        tokenUrl = tokenUrl || (asMetadata.token_endpoint as string | undefined);
        scopes = scopes || (Array.isArray(asMetadata.scopes_supported) ? asMetadata.scopes_supported : undefined);
    }

    if (!authUrl || !tokenUrl) {
        throw new Error('OAuth discovery failed: missing authorization or token endpoint');
    }

    return { authUrl, tokenUrl, scopes, resource };
}

function normalizeScopes(rawScopes?: string): string | undefined {
    if (!rawScopes) return undefined;
    return rawScopes
        .split(',')
        .map(scope => scope.trim())
        .filter(Boolean)
        .join(' ');
}

export async function handleAuth(options: AuthOptions) {
    const port = options.port || 3333;
    const redirectUri = `http://localhost:${port}/callback`;
    const state = uuidv4();
    const codeVerifier = options.usePkce ? createCodeVerifier() : undefined;
    const codeChallenge = codeVerifier ? createCodeChallenge(codeVerifier) : undefined;

    const fastify = Fastify();
    let resolvedScopes = normalizeScopes(options.scopes);
    let resolvedAuthUrl = options.authUrl;
    let resolvedTokenUrl = options.tokenUrl;
    let resolvedResource: string | undefined;

    if (options.mcpUrl) {
        const discovered = await discoverOAuthFromMcp(options.mcpUrl);
        resolvedAuthUrl = discovered.authUrl;
        resolvedTokenUrl = discovered.tokenUrl;
        resolvedResource = discovered.resource;
        if (!resolvedScopes && discovered.scopes && discovered.scopes.length > 0) {
            resolvedScopes = discovered.scopes.join(' ');
        }
    }

    if (!resolvedAuthUrl || !resolvedTokenUrl) {
        throw new Error('OAuth configuration missing authUrl or tokenUrl (set --mcp-url or provide both)');
    }

    return new Promise<void>((resolve, reject) => {
        fastify.get('/callback', async (request, reply) => {
            const { code, state: returnedState, error, error_description } = request.query as any;

            if (error) {
                reply.send(`Authentication failed: ${error} - ${error_description}`);
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (returnedState !== state) {
                reply.send('Invalid state parameter');
                reject(new Error('State mismatch'));
                return;
            }

            try {
                const body = new URLSearchParams();
                body.set('grant_type', 'authorization_code');
                body.set('code', code);
                body.set('redirect_uri', redirectUri);
                body.set('client_id', options.clientId);
                if (options.clientSecret) {
                    body.set('client_secret', options.clientSecret);
                }
                if (codeVerifier) {
                    body.set('code_verifier', codeVerifier);
                }
                if (resolvedResource) {
                    body.set('resource', resolvedResource);
                }

                const response = await axios.post(resolvedTokenUrl, body, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                    },
                });

                const { refresh_token, access_token } = response.data;

                console.log('\n--- Authentication Successful ---\n');
                console.log('Use these values in your conduit.yaml:\n');
                console.log('credentials:');
                console.log('  type: oauth2');
                console.log(`  clientId: ${options.clientId}`);
                if (options.clientSecret) {
                    console.log(`  clientSecret: ${options.clientSecret}`);
                }
                console.log(`  tokenUrl: "${resolvedTokenUrl}"`);
                console.log(`  refreshToken: "${refresh_token || 'N/A (No refresh token returned)'}"`);
                if (resolvedScopes) {
                    console.log(`  scopes: ["${resolvedScopes.split(' ').join('", "')}"]`);
                }

                if (!refresh_token) {
                    console.log('\nWarning: No refresh token was returned. Ensure your app has "offline_access" scope or similar.');
                }

                console.log('\nRaw response data:', JSON.stringify(response.data, null, 2));

                reply.send('Authentication successful! You can close this window and return to the terminal.');
                resolve();
            } catch (err: any) {
                const msg = err.response?.data?.error_description || err.response?.data?.error || err.message;
                reply.send(`Failed to exchange code for token: ${msg}`);
                reject(new Error(`Token exchange failed: ${msg}`));
            } finally {
                setTimeout(() => fastify.close(), 1000);
            }
        });

        fastify.listen({ port: port, host: '127.0.0.1' }, async (err) => {
            if (err) {
                reject(err);
                return;
            }

            const authUrl = new URL(resolvedAuthUrl);
            authUrl.searchParams.append('client_id', options.clientId);
            authUrl.searchParams.append('redirect_uri', redirectUri);
            authUrl.searchParams.append('response_type', 'code');
            authUrl.searchParams.append('state', state);
            if (resolvedScopes) {
                authUrl.searchParams.append('scope', resolvedScopes);
            }
            if (codeChallenge) {
                authUrl.searchParams.append('code_challenge', codeChallenge);
                authUrl.searchParams.append('code_challenge_method', 'S256');
            }
            if (resolvedResource) {
                authUrl.searchParams.append('resource', resolvedResource);
            }

            console.log(`Opening browser to: ${authUrl.toString()}`);
            console.log('Waiting for callback...');
            await open(authUrl.toString());
        });
    });
}

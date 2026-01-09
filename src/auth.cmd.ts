import Fastify from 'fastify';
import axios from 'axios';
import open from 'open';
import { v4 as uuidv4 } from 'uuid';

export interface AuthOptions {
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scopes?: string;
    port?: number;
}

export async function handleAuth(options: AuthOptions) {
    const port = options.port || 3333;
    const redirectUri = `http://localhost:${port}/callback`;
    const state = uuidv4();

    const fastify = Fastify();

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
                const response = await axios.post(options.tokenUrl, {
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                    client_id: options.clientId,
                    client_secret: options.clientSecret,
                });

                const { refresh_token, access_token } = response.data;

                console.log('\n--- Authentication Successful ---\n');
                console.log('Use these values in your conduit.yaml:\n');
                console.log('credentials:');
                console.log('  type: oauth2');
                console.log(`  clientId: ${options.clientId}`);
                console.log(`  clientSecret: ${options.clientSecret}`);
                console.log(`  tokenUrl: "${options.tokenUrl}"`);
                console.log(`  refreshToken: "${refresh_token || 'N/A (No refresh token returned)'}"`);

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

            const authUrl = new URL(options.authUrl);
            authUrl.searchParams.append('client_id', options.clientId);
            authUrl.searchParams.append('redirect_uri', redirectUri);
            authUrl.searchParams.append('response_type', 'code');
            authUrl.searchParams.append('state', state);
            if (options.scopes) {
                authUrl.searchParams.append('scope', options.scopes);
            }

            console.log(`Opening browser to: ${authUrl.toString()}`);
            console.log('Waiting for callback...');
            await open(authUrl.toString());
        });
    });
}

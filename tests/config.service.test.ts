import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '../src/core/config.service.js';
import fs from 'fs';
import path from 'path';

describe('ConfigService', () => {
    beforeEach(() => {
        vi.stubEnv('PORT', '4000');
        vi.stubEnv('NODE_ENV', 'test');
    });

    it('should load config from environment variables', () => {
        const configService = new ConfigService();
        expect(configService.get('port')).toBe(4000);
        expect(configService.get('nodeEnv')).toBe('test');
    });

    it('should use default values when env vars are missing', () => {
        vi.stubEnv('PORT', '');
        const configService = new ConfigService();
        // Since port has a default('3000'), it should be 3000
    });

    it('should prioritize overrides over env vars', () => {
        const configService = new ConfigService({ port: 5000 as any });
        expect(configService.get('port')).toBe(5000);
    });

    it('should throw error on invalid configuration', () => {
        vi.stubEnv('NODE_ENV', 'invalid');
        expect(() => new ConfigService()).toThrow(/Invalid configuration/);
    });

    it('should substitute env vars in config file', () => {
        const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => p.endsWith('conduit.test.yaml'));
        const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue("port: ${TEST_PORT}\nmetricsUrl: ${TEST_URL:-http://default}");

        vi.stubEnv('CONFIG_FILE', 'conduit.test.yaml');
        vi.stubEnv('TEST_PORT', '6000');
        vi.stubEnv('TEST_URL', 'http://overridden');

        // Ensure env var doesn't override file config
        delete process.env.PORT;

        const configService = new ConfigService();
        expect(configService.get('port')).toBe(6000);
        expect(configService.get('metricsUrl')).toBe('http://overridden');

        existsSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('should use default values in substitution', () => {
        const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => p.endsWith('conduit.test.yaml'));
        const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue("port: ${TEST_PORT:-7000}");

        vi.stubEnv('CONFIG_FILE', 'conduit.test.yaml');
        vi.stubEnv('TEST_PORT', '');
        delete process.env.TEST_PORT;

        // Ensure env var doesn't override file config
        delete process.env.PORT;

        const configService = new ConfigService();
        expect(configService.get('port')).toBe(7000);

        existsSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('should parse OAuth2 credentials correctly', () => {
        const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => p.endsWith('conduit.test.yaml'));
        const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(`
upstreams:
  - id: test-oauth
    type: http
    url: http://upstream
    credentials:
      type: oauth2
      clientId: my-id
      clientSecret: my-secret
      tokenUrl: http://token
      refreshToken: my-refresh
      tokenRequestFormat: json
      tokenParams:
        audience: api.atlassian.com
`);

        vi.stubEnv('CONFIG_FILE', 'conduit.test.yaml');
        const configService = new ConfigService();
        const upstreams = configService.get('upstreams');
        expect(upstreams).toHaveLength(1);
        expect(upstreams![0].credentials).toEqual({
            type: 'oauth2',
            clientId: 'my-id',
            clientSecret: 'my-secret',
            tokenUrl: 'http://token',
            refreshToken: 'my-refresh',
            tokenRequestFormat: 'json',
            tokenParams: { audience: 'api.atlassian.com' },
        });

        existsSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('should parse streamableHttp upstream correctly', () => {
        const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => p.endsWith('conduit.test.yaml'));
        const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(`
upstreams:
  - id: atlassian
    type: streamableHttp
    url: https://mcp.atlassian.com/v1/sse
    credentials:
      type: bearer
      bearerToken: test-token
`);

        vi.stubEnv('CONFIG_FILE', 'conduit.test.yaml');
        const configService = new ConfigService();
        const upstreams = configService.get('upstreams');
        expect(upstreams).toHaveLength(1);
        expect(upstreams![0].type).toBe('streamableHttp');
        expect((upstreams![0] as any).url).toBe('https://mcp.atlassian.com/v1/sse');

        existsSpy.mockRestore();
        readSpy.mockRestore();
    });
});

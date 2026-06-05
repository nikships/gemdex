import {
    resolveMode,
    loadRemoteConfig,
    resolveRemoteConnection,
} from './remote-config';
import { GemdexConfigError } from './errors';

/** Build an injectable env getter from a plain record. */
function makeEnv(vars: Record<string, string>): (name: string) => string | undefined {
    return (name: string) => vars[name];
}

// ---------------------------------------------------------------------------
// resolveMode
// ---------------------------------------------------------------------------

describe('resolveMode', () => {
    it('defaults to "local" when GEMDEX_MODE is unset', () => {
        expect(resolveMode(makeEnv({}))).toBe('local');
    });

    it('defaults to "local" when GEMDEX_MODE is an empty string', () => {
        expect(resolveMode(makeEnv({ GEMDEX_MODE: '' }))).toBe('local');
    });

    it('returns "local" when GEMDEX_MODE is explicitly "local"', () => {
        expect(resolveMode(makeEnv({ GEMDEX_MODE: 'local' }))).toBe('local');
    });

    it('returns "remote" when GEMDEX_MODE is "remote"', () => {
        expect(resolveMode(makeEnv({ GEMDEX_MODE: 'remote' }))).toBe('remote');
    });

    it('throws GemdexConfigError for an unrecognized GEMDEX_MODE', () => {
        expect(() => resolveMode(makeEnv({ GEMDEX_MODE: 'cloud' }))).toThrow(GemdexConfigError);
        expect(() => resolveMode(makeEnv({ GEMDEX_MODE: 'cloud' }))).toThrow('GEMDEX_MODE');
    });

    it('resolves GEMDEX_MODE case-insensitively', () => {
        expect(resolveMode(makeEnv({ GEMDEX_MODE: 'REMOTE' }))).toBe('remote');
        expect(resolveMode(makeEnv({ GEMDEX_MODE: 'Remote' }))).toBe('remote');
        expect(resolveMode(makeEnv({ GEMDEX_MODE: 'LOCAL' }))).toBe('local');
    });

    it('trims surrounding whitespace before resolving the mode', () => {
        expect(resolveMode(makeEnv({ GEMDEX_MODE: '  remote  ' }))).toBe('remote');
    });

    it('preserves the original value in the error message for an unrecognized mode', () => {
        expect(() => resolveMode(makeEnv({ GEMDEX_MODE: 'Cloud' }))).toThrow('Cloud');
    });
});

// ---------------------------------------------------------------------------
// loadRemoteConfig
// ---------------------------------------------------------------------------

describe('loadRemoteConfig', () => {
    it('returns null when GEMDEX_REMOTE_URL is unset', () => {
        expect(loadRemoteConfig(makeEnv({}))).toBeNull();
    });

    it('returns null when GEMDEX_REMOTE_URL is empty', () => {
        expect(loadRemoteConfig(makeEnv({ GEMDEX_REMOTE_URL: '' }))).toBeNull();
    });

    it('returns a RemoteConfig with defaults when only GEMDEX_REMOTE_URL is set', () => {
        const config = loadRemoteConfig(makeEnv({ GEMDEX_REMOTE_URL: 'https://my.server.com' }));
        expect(config).not.toBeNull();
        expect(config!.url).toBe('https://my.server.com');
        expect(config!.tokenEnvVar).toBe('GEMDEX_REMOTE_TOKEN');
        expect(config!.name).toBe('gemdex-remote');
    });

    it('respects GEMDEX_REMOTE_NAME and GEMDEX_REMOTE_TOKEN_ENV_VAR overrides', () => {
        const config = loadRemoteConfig(
            makeEnv({
                GEMDEX_REMOTE_URL: 'https://my.server.com',
                GEMDEX_REMOTE_NAME: 'prod',
                GEMDEX_REMOTE_TOKEN_ENV_VAR: 'MY_CUSTOM_TOKEN',
            }),
        );
        expect(config!.name).toBe('prod');
        expect(config!.tokenEnvVar).toBe('MY_CUSTOM_TOKEN');
    });

    it('strips trailing slashes from the remote URL', () => {
        expect(loadRemoteConfig(makeEnv({ GEMDEX_REMOTE_URL: 'https://my.server.com/' }))!.url)
            .toBe('https://my.server.com');
        expect(loadRemoteConfig(makeEnv({ GEMDEX_REMOTE_URL: 'https://my.server.com/api//' }))!.url)
            .toBe('https://my.server.com/api');
    });
});

// ---------------------------------------------------------------------------
// resolveRemoteConnection
// ---------------------------------------------------------------------------

describe('resolveRemoteConnection', () => {
    it('throws GemdexConfigError when remote mode selected but no URL configured', () => {
        expect(() => resolveRemoteConnection(makeEnv({}))).toThrow(GemdexConfigError);
        expect(() => resolveRemoteConnection(makeEnv({}))).toThrow('GEMDEX_REMOTE_URL');
    });

    it('throws GemdexConfigError for an invalid URL', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'not-a-url',
            GEMDEX_REMOTE_TOKEN: 'tok',
        });
        expect(() => resolveRemoteConnection(env)).toThrow(GemdexConfigError);
        expect(() => resolveRemoteConnection(env)).toThrow('not-a-url');
    });

    it('throws GemdexConfigError for a non-http/https URL', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'ftp://files.example.com',
            GEMDEX_REMOTE_TOKEN: 'tok',
        });
        expect(() => resolveRemoteConnection(env)).toThrow(GemdexConfigError);
        expect(() => resolveRemoteConnection(env)).toThrow('ftp');
    });

    it('throws GemdexConfigError when token env var is missing', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'https://my.server.com',
            // GEMDEX_REMOTE_TOKEN intentionally absent
        });
        expect(() => resolveRemoteConnection(env)).toThrow(GemdexConfigError);
        expect(() => resolveRemoteConnection(env)).toThrow('GEMDEX_REMOTE_TOKEN');
    });

    it('throws GemdexConfigError when token env var is set but empty', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'https://my.server.com',
            GEMDEX_REMOTE_TOKEN: '   ',
        });
        expect(() => resolveRemoteConnection(env)).toThrow(GemdexConfigError);
    });

    it('resolves { url, token } for a fully configured remote without requiring GEMINI_API_KEY', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'https://my.server.com',
            GEMDEX_REMOTE_TOKEN: 'supersecret',
            // GEMINI_API_KEY is intentionally absent — remote servers own embedding
        });
        const conn = resolveRemoteConnection(env);
        expect(conn.url).toBe('https://my.server.com');
        expect(conn.token).toBe('supersecret');
    });

    it('accepts http:// URLs (not just https://)', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'http://localhost:4000',
            GEMDEX_REMOTE_TOKEN: 'devtoken',
        });
        const conn = resolveRemoteConnection(env);
        expect(conn.url).toBe('http://localhost:4000');
    });

    it('resolves the token from a custom token env var', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'https://my.server.com',
            GEMDEX_REMOTE_TOKEN_ENV_VAR: 'MY_TOKEN',
            MY_TOKEN: 'custom-bearer',
        });
        const conn = resolveRemoteConnection(env);
        expect(conn.token).toBe('custom-bearer');
    });

    it('returns a trailing-slash-normalized URL', () => {
        const env = makeEnv({
            GEMDEX_REMOTE_URL: 'https://my.server.com/',
            GEMDEX_REMOTE_TOKEN: 'tok',
        });
        expect(resolveRemoteConnection(env).url).toBe('https://my.server.com');
    });
});

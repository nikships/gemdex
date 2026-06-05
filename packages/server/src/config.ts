import * as fs from 'fs';

export interface ServerConfig {
    host: string;
    port: number;
    /** Bearer token required for data-route auth unless unsafeDevNoAuth is true. */
    token?: string;
    /** Explicit unsafe local/dev mode that disables bearer-token auth. */
    unsafeDevNoAuth: boolean;
    /** Browser origins allowed by CORS. Empty denies cross-origin browser data access. */
    allowedOrigins: string[];
}

export interface LoadServerConfigOptions {
    env?: Record<string, string | undefined>;
    argv?: string[];
}

/**
 * Resolve the server configuration from environment variables, optional CLI
 * arguments, and an optional JSON config file.
 *
 * Priority (highest to lowest):
 *   1. Explicit env vars (GEMDEX_SERVER_HOST, GEMDEX_SERVER_PORT, GEMDEX_SERVER_TOKEN, etc.).
 *   2. CLI args (--host, --port).
 *   3. Config file (GEMDEX_SERVER_CONFIG env var or --config <path> arg).
 *   4. Built-in defaults (host: 127.0.0.1, port: 8765).
 */
export function loadServerConfig(options: LoadServerConfigOptions = {}): ServerConfig {
    const env = options.env ?? process.env;
    const argv = options.argv ?? process.argv.slice(2);

    // Parse CLI args for --host, --port, --config, --allowed-origin, and
    // --unsafe-dev-no-auth.
    let argHost: string | undefined;
    let argPort: string | undefined;
    let argConfig: string | undefined;
    const argAllowedOrigins: string[] = [];
    let argUnsafeDevNoAuth: boolean | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--host' || arg === '-H') {
            argHost = argv[++i];
        } else if (arg.startsWith('--host=')) {
            argHost = arg.slice('--host='.length);
        } else if (arg === '--port' || arg === '-p') {
            argPort = argv[++i];
        } else if (arg.startsWith('--port=')) {
            argPort = arg.slice('--port='.length);
        } else if (arg === '--config' || arg === '-c') {
            argConfig = argv[++i];
        } else if (arg.startsWith('--config=')) {
            argConfig = arg.slice('--config='.length);
        } else if (arg === '--allowed-origin') {
            const value = argv[++i];
            if (value !== undefined) {
                argAllowedOrigins.push(value);
            }
        } else if (arg.startsWith('--allowed-origin=')) {
            argAllowedOrigins.push(arg.slice('--allowed-origin='.length));
        } else if (arg === '--unsafe-dev-no-auth') {
            argUnsafeDevNoAuth = true;
        }
    }

    // Load config file if specified (via env or CLI arg).
    const configPath = env['GEMDEX_SERVER_CONFIG'] ?? argConfig;
    let fileConfig: Record<string, unknown> = {};
    if (configPath) {
        let raw: string;
        try {
            raw = fs.readFileSync(configPath, 'utf-8');
        } catch (err) {
            const detail = err instanceof Error ? err.message : 'file not found';
            throw new Error(
                `Cannot read config file '${configPath}': ${detail}. ` +
                'Check that the path is correct and the file is readable.',
            );
        }
        try {
            fileConfig = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Config file '${configPath}' contains invalid JSON: ${detail}. ` +
                'Ensure the file is well-formed JSON.',
            );
        }
    }

    // Resolve host: env > CLI arg > file > default.
    const host =
        env['GEMDEX_SERVER_HOST'] ??
        argHost ??
        (typeof fileConfig['host'] === 'string' ? fileConfig['host'] : undefined) ??
        '127.0.0.1';

    // Resolve port raw string: env > CLI arg > file > default.
    const portRaw =
        env['GEMDEX_SERVER_PORT'] ??
        argPort ??
        (fileConfig['port'] !== undefined ? String(fileConfig['port']) : undefined) ??
        '8765';

    const portNum = Number(portRaw);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error(
            `Invalid port '${portRaw}': must be an integer between 1 and 65535. ` +
            'Set GEMDEX_SERVER_PORT or --port to a valid port number.',
        );
    }

    // Resolve token: env > file. Required unless unsafe dev mode is explicit.
    const token =
        normalizeNonEmpty(env['GEMDEX_SERVER_TOKEN']) ??
        (typeof fileConfig['token'] === 'string' ? normalizeNonEmpty(fileConfig['token']) : undefined);

    const unsafeDevNoAuth =
        parseBoolean(env['GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH'], 'GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH') ??
        argUnsafeDevNoAuth ??
        (typeof fileConfig['unsafeDevNoAuth'] === 'boolean' ? fileConfig['unsafeDevNoAuth'] : false);

    const allowedOrigins = resolveAllowedOrigins(env, argAllowedOrigins, fileConfig);

    if (!token && !unsafeDevNoAuth) {
        throw new Error(
            'GEMDEX_SERVER_TOKEN is required for gemdex-server. Set a strong bearer token, ' +
            'or explicitly set GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH=true for unsafe local development only.',
        );
    }

    return {
        host,
        port: portNum,
        unsafeDevNoAuth,
        allowedOrigins,
        ...(token !== undefined && { token }),
    };
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`${name} must be true or false.`);
}

function splitOrigins(value: string): string[] {
    return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

function resolveAllowedOrigins(
    env: Record<string, string | undefined>,
    argAllowedOrigins: string[],
    fileConfig: Record<string, unknown>,
): string[] {
    const envOrigins = env['GEMDEX_SERVER_ALLOWED_ORIGINS'];
    if (envOrigins !== undefined) {
        return splitOrigins(envOrigins);
    }
    if (argAllowedOrigins.length > 0) {
        return argAllowedOrigins.flatMap(splitOrigins);
    }
    if (Array.isArray(fileConfig['allowedOrigins'])) {
        return fileConfig['allowedOrigins']
            .filter((origin): origin is string => typeof origin === 'string')
            .flatMap(splitOrigins);
    }
    if (typeof fileConfig['allowedOrigins'] === 'string') {
        return splitOrigins(fileConfig['allowedOrigins']);
    }
    return [];
}


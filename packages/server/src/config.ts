import * as fs from 'fs';

export interface ServerConfig {
    host: string;
    port: number;
    /** Optional bearer token. Auth is enforced in GEM-13; stored here for forward-compat. */
    token?: string;
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
 *   1. Explicit env vars (GEMDEX_SERVER_HOST, GEMDEX_SERVER_PORT, GEMDEX_SERVER_TOKEN).
 *   2. CLI args (--host, --port).
 *   3. Config file (GEMDEX_SERVER_CONFIG env var or --config <path> arg).
 *   4. Built-in defaults (host: 127.0.0.1, port: 8765).
 */
export function loadServerConfig(options: LoadServerConfigOptions = {}): ServerConfig {
    const env = options.env ?? process.env;
    const argv = options.argv ?? process.argv.slice(2);

    // Parse CLI args for --host, --port, --config.
    let argHost: string | undefined;
    let argPort: string | undefined;
    let argConfig: string | undefined;

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
        }
    }

    // Load config file if specified (via env or CLI arg).
    const configPath = env['GEMDEX_SERVER_CONFIG'] ?? argConfig;
    let fileConfig: Record<string, unknown> = {};
    if (configPath) {
        let raw: string;
        try {
            raw = fs.readFileSync(configPath, 'utf-8');
        } catch (err: any) {
            throw new Error(
                `Cannot read config file '${configPath}': ${err?.message ?? 'file not found'}. ` +
                'Check that the path is correct and the file is readable.',
            );
        }
        try {
            fileConfig = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            throw new Error(
                `Config file '${configPath}' contains invalid JSON. ` +
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

    // Resolve optional token: env > file.
    const token =
        env['GEMDEX_SERVER_TOKEN'] ??
        (typeof fileConfig['token'] === 'string' ? fileConfig['token'] : undefined);

    return { host, port: portNum, ...(token !== undefined && { token }) };
}

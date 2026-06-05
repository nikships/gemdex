import * as fs from 'fs';

export type BlobStoreKind = 'file' | 's3';

export interface FileBlobStoreConfig {
    kind: 'file';
    directory?: string;
}

export interface S3BlobStoreConfig {
    kind: 's3';
    bucket: string;
    prefix?: string;
    endpoint?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
}

export type BlobStoreConfig = FileBlobStoreConfig | S3BlobStoreConfig;

export interface ServerConfig {
    host: string;
    port: number;
    /** Optional bearer token. Auth is enforced in GEM-13; stored here for forward-compat. */
    token?: string;
    /** Attachment blob storage backend for self-hosted deployments. */
    blobStore: BlobStoreConfig;
}

export interface LoadServerConfigOptions {
    env?: Record<string, string | undefined>;
    argv?: string[];
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseBoolean(value: unknown, name: string): boolean | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') {
        throw new Error(`Invalid ${name}: must be true or false.`);
    }
    const normalized = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`Invalid ${name} '${value}': must be true or false.`);
}

function resolveBlobStore(env: Record<string, string | undefined>, fileConfig: Record<string, unknown>): BlobStoreConfig {
    const fileBlobStore = fileConfig['blobStore'] && typeof fileConfig['blobStore'] === 'object'
        ? fileConfig['blobStore'] as Record<string, unknown>
        : {};
    const kindRaw = optionalString(env['BLOB_STORE']) ?? optionalString(fileBlobStore['kind']) ?? 'file';
    const kind = kindRaw.toLowerCase();

    if (kind === 'file') {
        const directory = optionalString(env['BLOB_DIR']) ?? optionalString(fileBlobStore['directory']);
        return { kind: 'file', ...(directory && { directory }) };
    }

    if (kind === 's3') {
        const bucket = optionalString(env['S3_BUCKET']) ?? optionalString(fileBlobStore['bucket']);
        if (!bucket) {
            throw new Error('BLOB_STORE=s3 requires S3_BUCKET (or blobStore.bucket in the config file).');
        }
        const endpoint = optionalString(env['S3_ENDPOINT']) ?? optionalString(fileBlobStore['endpoint']);
        const region = optionalString(env['S3_REGION']) ?? optionalString(fileBlobStore['region']) ?? 'auto';
        const prefix = optionalString(env['S3_PREFIX']) ?? optionalString(fileBlobStore['prefix']);
        const accessKeyId = optionalString(env['S3_ACCESS_KEY_ID']) ?? optionalString(env['AWS_ACCESS_KEY_ID']) ?? optionalString(fileBlobStore['accessKeyId']);
        const secretAccessKey = optionalString(env['S3_SECRET_ACCESS_KEY']) ?? optionalString(env['AWS_SECRET_ACCESS_KEY']) ?? optionalString(fileBlobStore['secretAccessKey']);
        const forcePathStyle = parseBoolean(optionalString(env['S3_FORCE_PATH_STYLE']) ?? fileBlobStore['forcePathStyle'], 'S3_FORCE_PATH_STYLE');
        return {
            kind: 's3',
            bucket,
            region,
            ...(endpoint && { endpoint }),
            ...(prefix && { prefix }),
            ...(accessKeyId && { accessKeyId }),
            ...(secretAccessKey && { secretAccessKey }),
            ...(forcePathStyle !== undefined && { forcePathStyle }),
        };
    }

    throw new Error(`Invalid BLOB_STORE '${kindRaw}': expected 'file' or 's3'.`);
}

/**
 * Resolve the server configuration from environment variables, optional CLI
 * arguments, and an optional JSON config file.
 *
 * Priority (highest to lowest):
 *   1. Explicit env vars (GEMDEX_SERVER_*, BLOB_STORE/BLOB_DIR/S3_*).
 *   2. CLI args (--host, --port).
 *   3. Config file (GEMDEX_SERVER_CONFIG env var or --config <path> arg).
 *   4. Built-in defaults (host: 127.0.0.1, port: 8765, BLOB_STORE=file).
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

    // Resolve optional token: env > file.
    const token =
        env['GEMDEX_SERVER_TOKEN'] ??
        (typeof fileConfig['token'] === 'string' ? fileConfig['token'] : undefined);

    return {
        host,
        port: portNum,
        ...(token !== undefined && { token }),
        blobStore: resolveBlobStore(env, fileConfig),
    };
}

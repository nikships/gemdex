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
    /** Bearer token required for data-route auth unless unsafeDevNoAuth is true. */
    token?: string;
    /** Explicit unsafe local/dev mode that disables bearer-token auth. */
    unsafeDevNoAuth: boolean;
    /** Browser origins allowed by CORS. Empty denies cross-origin browser data access. */
    allowedOrigins: string[];
    /** Optional Postgres connection string for the remote memory backend. */
    databaseUrl?: string;
    /** Server-owned Gemini API key. Remote clients never need this value. */
    geminiApiKey?: string;
    /** Gemini embedding model used for server-side save/recall/update work. */
    embeddingModel: string;
    /** Optional custom Gemini API base URL. */
    geminiBaseUrl?: string;
    /** Optional embedding output dimensionality override. */
    embeddingDimension?: number;
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

/** Read a string-typed field from the parsed JSON config, preserving empty strings. */
function fileString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
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

function parsePositiveInteger(value: unknown, name: string): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(`Invalid ${name} '${String(value)}': must be a positive integer.`);
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid ${name} '${String(value)}': must be a positive integer.`);
    }
    return parsed;
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
 *   1. Explicit env vars (GEMDEX_SERVER_*, DATABASE_URL, BLOB_STORE/BLOB_DIR/S3_*).
 *   2. CLI args (--host, --port, --database-url, --allowed-origin).
 *   3. Config file (GEMDEX_SERVER_CONFIG env var or --config <path> arg).
 *   4. Built-in defaults (host: 127.0.0.1, port: 8765, BLOB_STORE=file).
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
    let argDatabaseUrl: string | undefined;

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
        } else if (arg === '--database-url') {
            argDatabaseUrl = argv[++i];
        } else if (arg.startsWith('--database-url=')) {
            argDatabaseUrl = arg.slice('--database-url='.length);
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
        fileString(fileConfig['host']) ??
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
        normalizeNonEmpty(fileString(fileConfig['token']));

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

    // Resolve optional Postgres database URL: env > CLI arg > file. DATABASE_URL
    // is supported for platform defaults; GEMDEX_SERVER_DATABASE_URL is the
    // explicit Gemdex-specific name.
    const databaseUrl =
        env['GEMDEX_SERVER_DATABASE_URL'] ??
        env['DATABASE_URL'] ??
        argDatabaseUrl ??
        fileString(fileConfig['databaseUrl']);
    const geminiApiKey =
        normalizeNonEmpty(env['GEMINI_API_KEY']) ??
        normalizeNonEmpty(fileString(fileConfig['geminiApiKey']));
    const embeddingModel =
        normalizeNonEmpty(env['EMBEDDING_MODEL']) ??
        normalizeNonEmpty(fileString(fileConfig['embeddingModel'])) ??
        'gemini-embedding-2';
    const geminiBaseUrl =
        normalizeNonEmpty(env['GEMINI_BASE_URL']) ??
        normalizeNonEmpty(fileString(fileConfig['geminiBaseUrl']));
    const embeddingDimension = parsePositiveInteger(
        env['EMBEDDING_DIMENSION'] ?? fileConfig['embeddingDimension'],
        'EMBEDDING_DIMENSION',
    );

    return {
        host,
        port: portNum,
        unsafeDevNoAuth,
        allowedOrigins,
        ...(token !== undefined && { token }),
        ...(databaseUrl !== undefined && { databaseUrl }),
        ...(geminiApiKey !== undefined && { geminiApiKey }),
        embeddingModel,
        ...(geminiBaseUrl !== undefined && { geminiBaseUrl }),
        ...(embeddingDimension !== undefined && { embeddingDimension }),
        blobStore: resolveBlobStore(env, fileConfig),
    };
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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

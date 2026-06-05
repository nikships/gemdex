import { envManager } from '../utils/env-manager';
import { GemdexConfigError } from './errors';

/**
 * The two operating modes for the gemdex client.
 * 'local' is the default: Gemini embeddings + embedded LanceDB on the user's machine.
 * 'remote' points at a user-owned Gemdex Server over HTTP.
 */
export type GemdexMode = 'local' | 'remote';

/**
 * A named remote server configuration.
 *
 * Auth is stored by reference: `tokenEnvVar` names the environment variable
 * that holds the bearer token at runtime. The raw secret is never persisted
 * in this object so long-lived tokens stay out of plain config objects.
 */
export interface RemoteConfig {
    /** Human-readable label for this remote (e.g. "my-server"). */
    name: string;
    /** Absolute http:// or https:// URL of the Gemdex Server root (no trailing slash). */
    url: string;
    /**
     * Name of the env var that holds the bearer token used to authenticate.
     * Defaults to `GEMDEX_REMOTE_TOKEN` when not explicitly set.
     */
    tokenEnvVar: string;
}

/**
 * A resolved remote connection ready for use: the concrete URL and the actual
 * bearer token value retrieved from the environment.
 *
 * Remote mode MUST NOT require GEMINI_API_KEY on the client — the server owns
 * embedding. This type intentionally carries only what an HTTP client needs.
 */
export interface ResolvedRemoteConnection {
    url: string;
    token: string;
}

/** Default env var name for the remote bearer token. */
const DEFAULT_TOKEN_ENV_VAR = 'GEMDEX_REMOTE_TOKEN';

/** Injectable env-getter type (mirrors EnvManager.get's signature). */
export type EnvGetter = (name: string) => string | undefined;

/** Default env getter bound to the shared envManager instance. */
const defaultEnvGetter: EnvGetter = (name: string) => envManager.get(name);

/**
 * Resolve the active `GemdexMode` from the environment.
 *
 * - Returns `'local'` when `GEMDEX_MODE` is unset or empty (local-first default).
 * - Throws `GemdexConfigError` for any value that is not `'local'` or `'remote'`.
 *
 * @param getEnv Injectable env getter; defaults to `envManager.get`.
 */
export function resolveMode(getEnv: EnvGetter = defaultEnvGetter): GemdexMode {
    const raw = (getEnv('GEMDEX_MODE') ?? '').trim();
    const normalized = raw.toLowerCase();

    if (normalized === '' || normalized === 'local') {
        return 'local';
    }
    if (normalized === 'remote') {
        return 'remote';
    }

    throw new GemdexConfigError(
        `Unrecognized GEMDEX_MODE value "${raw}". Expected "local" or "remote".`,
    );
}

/**
 * Load `RemoteConfig` from env vars.
 *
 * Returns `null` when `GEMDEX_REMOTE_URL` is not set (i.e. no remote is configured).
 *
 * @param getEnv Injectable env getter; defaults to `envManager.get`.
 */
export function loadRemoteConfig(getEnv: EnvGetter = defaultEnvGetter): RemoteConfig | null {
    const trimmedUrl = (getEnv('GEMDEX_REMOTE_URL') ?? '').trim();
    if (!trimmedUrl) {
        return null;
    }

    const name = getEnv('GEMDEX_REMOTE_NAME') ?? 'gemdex-remote';
    const tokenEnvVar = getEnv('GEMDEX_REMOTE_TOKEN_ENV_VAR') ?? DEFAULT_TOKEN_ENV_VAR;

    // Normalize away trailing slashes so later path joins (e.g. `${url}/v1/version`)
    // never produce a double slash.
    const url = trimmedUrl.replace(/\/+$/, '');

    return { name, url, tokenEnvVar };
}

/**
 * Resolve a complete remote connection (`url` + bearer `token`) for use by an
 * HTTP client.
 *
 * Throws `GemdexConfigError` with a clear, actionable message for each failure:
 *   (a) remote mode selected but no `GEMDEX_REMOTE_URL` configured
 *   (b) URL is present but is not an absolute http:// or https:// URL
 *   (c) URL is valid but the referenced token env var is missing or empty
 *
 * Notably, this function does NOT inspect `GEMINI_API_KEY`; remote servers own
 * embedding and clients do not need that key in remote mode.
 *
 * @param getEnv Injectable env getter; defaults to `envManager.get`.
 */
export function resolveRemoteConnection(
    getEnv: EnvGetter = defaultEnvGetter,
): ResolvedRemoteConnection {
    const config = loadRemoteConfig(getEnv);

    if (config === null) {
        throw new GemdexConfigError(
            'GEMDEX_MODE is set to "remote" but GEMDEX_REMOTE_URL is not configured. ' +
                'Set GEMDEX_REMOTE_URL to the absolute URL of your Gemdex Server ' +
                '(e.g. https://gemdex.example.com).',
        );
    }

    // Validate the URL is an absolute http or https URL.
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(config.url);
    } catch {
        throw new GemdexConfigError(
            `GEMDEX_REMOTE_URL "${config.url}" is not a valid URL. ` +
                'Provide an absolute http:// or https:// URL ' +
                '(e.g. https://gemdex.example.com).',
        );
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new GemdexConfigError(
            `GEMDEX_REMOTE_URL "${config.url}" must use the http or https scheme. ` +
                `Got "${parsedUrl.protocol.replace(':', '')}".`,
        );
    }

    // Resolve the bearer token from the referenced env var.
    const token = getEnv(config.tokenEnvVar) ?? '';
    if (!token.trim()) {
        throw new GemdexConfigError(
            `Remote token env var "${config.tokenEnvVar}" is not set or is empty. ` +
                `Set ${config.tokenEnvVar} to the bearer token for your Gemdex Server. ` +
                'The env var name can be changed with GEMDEX_REMOTE_TOKEN_ENV_VAR.',
        );
    }

    return { url: config.url, token: token.trim() };
}

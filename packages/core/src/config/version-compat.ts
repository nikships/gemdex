import { RemoteCompatibilityError } from './errors';

/**
 * Shape of the `GET /v1/version` response from a Gemdex Server.
 * See docs/BYOI_REMOTE_MODE.md — "Health And Version" section.
 */
export interface ServerVersionInfo {
    name: string;
    apiVersion: string;
    serverVersion: string;
    minClientVersion: string;
    protocolVersion: number;
    capabilities: Record<string, unknown>;
}

/**
 * What THIS client supports.
 *
 * CLIENT_VERSION is kept in sync with the gemdex-core package.json version
 * rather than importing it at runtime (avoids a dynamic require through dist
 * paths in test environments). Update this constant on every package release.
 */
export const CLIENT_VERSION = '0.3.9';
export const SUPPORTED_API_VERSION = 'v1';
export const SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * Parse a "x.y.z" semver string into a comparable numeric triple.
 * Returns [0, 0, 0] for any unparseable input so callers receive a defined result.
 */
function parseSemver(version: string): [number, number, number] {
    const parts = version.split('.').map(Number);
    const major = Number.isFinite(parts[0]) ? parts[0] : 0;
    const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
    const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
    return [major, minor, patch];
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
    const [aMaj, aMin, aPatch] = parseSemver(a);
    const [bMaj, bMin, bPatch] = parseSemver(b);

    if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
    if (aMin !== bMin) return aMin < bMin ? -1 : 1;
    if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
    return 0;
}

export interface CompatibilityCheckOptions {
    /** Override the client version used in error messages (defaults to CLIENT_VERSION). */
    clientVersion?: string;
}

/**
 * Check that a server's version response is compatible with this client.
 *
 * Throws `RemoteCompatibilityError` when incompatible. Error messages follow
 * the doc's example style and name both what is installed and what is required:
 *   "Gemdex client 0.3.9 requires Gemdex Server API v1 protocolVersion 1;
 *    server returned API v1 protocolVersion 2."
 *
 * Checks (in order):
 *   1. `apiVersion` must equal `SUPPORTED_API_VERSION` ("v1").
 *   2. `protocolVersion` must equal `SUPPORTED_PROTOCOL_VERSION` (1).
 *   3. Client must not be older than the server's `minClientVersion`.
 *
 * @param serverInfo The parsed response from `GET /v1/version`.
 * @param options    Optional overrides (e.g. for testing with a specific client version).
 */
export function checkServerCompatibility(
    serverInfo: ServerVersionInfo,
    options: CompatibilityCheckOptions = {},
): void {
    const clientVersion = options.clientVersion ?? CLIENT_VERSION;

    if (serverInfo.apiVersion !== SUPPORTED_API_VERSION) {
        throw new RemoteCompatibilityError(
            `Gemdex client ${clientVersion} supports API version "${SUPPORTED_API_VERSION}"; ` +
                `server returned API version "${serverInfo.apiVersion}". ` +
                'Upgrade your Gemdex client or server to a compatible version.',
        );
    }

    if (serverInfo.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
        throw new RemoteCompatibilityError(
            `Gemdex client ${clientVersion} requires Gemdex Server API ${SUPPORTED_API_VERSION} ` +
                `protocolVersion ${SUPPORTED_PROTOCOL_VERSION}; ` +
                `server returned API ${serverInfo.apiVersion} protocolVersion ${serverInfo.protocolVersion}.`,
        );
    }

    if (compareSemver(clientVersion, serverInfo.minClientVersion) < 0) {
        throw new RemoteCompatibilityError(
            `Gemdex client ${clientVersion} is below the minimum required by this server ` +
                `(${serverInfo.minClientVersion}). ` +
                `Upgrade your Gemdex client to at least ${serverInfo.minClientVersion}.`,
        );
    }
}

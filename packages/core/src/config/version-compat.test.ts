import {
    checkServerCompatibility,
    ServerVersionInfo,
    CLIENT_VERSION,
    SUPPORTED_API_VERSION,
    SUPPORTED_PROTOCOL_VERSION,
} from './version-compat';
import { RemoteCompatibilityError } from './errors';

/** Helper: build a fully compatible ServerVersionInfo. Spread-override individual fields to test failures. */
function compatibleServer(overrides: Partial<ServerVersionInfo> = {}): ServerVersionInfo {
    return {
        name: 'gemdex-server',
        apiVersion: SUPPORTED_API_VERSION,
        serverVersion: '0.1.0',
        minClientVersion: '0.1.0',
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: {
            attachments: true,
            recallAttachments: true,
            importExport: true,
            auth: ['bearer'],
        },
        ...overrides,
    };
}

describe('checkServerCompatibility', () => {
    it('passes without throwing for a fully compatible server', () => {
        expect(() => checkServerCompatibility(compatibleServer())).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // apiVersion mismatch
    // -----------------------------------------------------------------------
    it('throws RemoteCompatibilityError on apiVersion mismatch', () => {
        const server = compatibleServer({ apiVersion: 'v2' });
        expect(() => checkServerCompatibility(server)).toThrow(RemoteCompatibilityError);
    });

    it('error message includes the client version, supported api version, and server api version', () => {
        const server = compatibleServer({ apiVersion: 'v2' });
        let caught: Error | null = null;
        try {
            checkServerCompatibility(server);
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).toBeInstanceOf(RemoteCompatibilityError);
        expect(caught!.message).toContain(CLIENT_VERSION);
        expect(caught!.message).toContain(SUPPORTED_API_VERSION);
        expect(caught!.message).toContain('v2');
    });

    // -----------------------------------------------------------------------
    // protocolVersion mismatch
    // -----------------------------------------------------------------------
    it('throws RemoteCompatibilityError on protocolVersion mismatch', () => {
        const server = compatibleServer({ protocolVersion: 2 });
        expect(() => checkServerCompatibility(server)).toThrow(RemoteCompatibilityError);
    });

    it('error message includes client version, api version, supported protocol version and server protocol version', () => {
        const server = compatibleServer({ protocolVersion: 2 });
        let caught: Error | null = null;
        try {
            checkServerCompatibility(server);
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).toBeInstanceOf(RemoteCompatibilityError);
        // Per doc example: "Gemdex client 0.3.7 requires Gemdex Server API v1 protocolVersion 1;
        //                   server returned API v1 protocolVersion 2."
        expect(caught!.message).toContain(CLIENT_VERSION);
        expect(caught!.message).toContain(SUPPORTED_API_VERSION);
        expect(caught!.message).toContain(String(SUPPORTED_PROTOCOL_VERSION));
        expect(caught!.message).toContain('2');
    });

    // -----------------------------------------------------------------------
    // client below minClientVersion
    // -----------------------------------------------------------------------
    it('throws RemoteCompatibilityError when client is below minClientVersion', () => {
        const server = compatibleServer({ minClientVersion: '99.0.0' });
        expect(() => checkServerCompatibility(server)).toThrow(RemoteCompatibilityError);
    });

    it('error message includes client version and minClientVersion when client is too old', () => {
        const server = compatibleServer({ minClientVersion: '99.0.0' });
        let caught: Error | null = null;
        try {
            checkServerCompatibility(server);
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).toBeInstanceOf(RemoteCompatibilityError);
        expect(caught!.message).toContain(CLIENT_VERSION);
        expect(caught!.message).toContain('99.0.0');
    });

    it('passes when client version equals minClientVersion exactly', () => {
        const server = compatibleServer({ minClientVersion: CLIENT_VERSION });
        expect(() => checkServerCompatibility(server)).not.toThrow();
    });

    it('passes when client version is above minClientVersion', () => {
        const server = compatibleServer({ minClientVersion: '0.1.0' });
        expect(() => checkServerCompatibility(server)).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // options.clientVersion override
    // -----------------------------------------------------------------------
    it('uses the injected clientVersion in error messages', () => {
        const server = compatibleServer({ minClientVersion: '5.0.0' });
        let caught: Error | null = null;
        try {
            checkServerCompatibility(server, { clientVersion: '0.3.7' });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).toBeInstanceOf(RemoteCompatibilityError);
        expect(caught!.message).toContain('0.3.7');
        expect(caught!.message).toContain('5.0.0');
    });

    it('does not throw when injected clientVersion satisfies minClientVersion', () => {
        const server = compatibleServer({ minClientVersion: '1.0.0' });
        expect(() => checkServerCompatibility(server, { clientVersion: '2.0.0' })).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // semver edge cases
    // -----------------------------------------------------------------------
    it('correctly orders minor and patch components (0.9.0 < 0.10.0)', () => {
        const server = compatibleServer({ minClientVersion: '0.10.0' });
        expect(() => checkServerCompatibility(server, { clientVersion: '0.9.0' })).toThrow(RemoteCompatibilityError);
    });

    it('tolerates a leading "v" on version strings', () => {
        const server = compatibleServer({ minClientVersion: 'v0.1.0' });
        expect(() => checkServerCompatibility(server, { clientVersion: 'v0.3.9' })).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // fail closed on malformed versions (do NOT treat as 0.0.0)
    // -----------------------------------------------------------------------
    it('throws when the server minClientVersion is not valid semver', () => {
        const server = compatibleServer({ minClientVersion: 'not-a-version' });
        expect(() => checkServerCompatibility(server)).toThrow(RemoteCompatibilityError);
        expect(() => checkServerCompatibility(server)).toThrow('invalid version');
    });

    it('throws when the injected client version is not valid semver', () => {
        const server = compatibleServer({ minClientVersion: '0.1.0' });
        expect(() => checkServerCompatibility(server, { clientVersion: 'garbage' }))
            .toThrow(RemoteCompatibilityError);
    });

    // -----------------------------------------------------------------------
    // defensive validation of the external serverInfo payload
    // -----------------------------------------------------------------------
    it('throws a clear error when serverInfo is missing or not an object', () => {
        expect(() => checkServerCompatibility(null as unknown as ServerVersionInfo))
            .toThrow(RemoteCompatibilityError);
        expect(() => checkServerCompatibility(undefined as unknown as ServerVersionInfo))
            .toThrow(RemoteCompatibilityError);
        expect(() => checkServerCompatibility('nope' as unknown as ServerVersionInfo))
            .toThrow('missing or invalid');
    });
});

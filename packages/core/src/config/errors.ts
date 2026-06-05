/**
 * Dedicated error types for gemdex remote configuration and compatibility failures.
 * Using named classes makes these errors reliably catchable with `instanceof`.
 */

export class GemdexConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GemdexConfigError';
    }
}

export class RemoteCompatibilityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RemoteCompatibilityError';
    }
}

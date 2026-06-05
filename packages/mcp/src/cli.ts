import {
    MemoryBackend,
    RemoteMemoryBackend,
    ServerVersionInfo,
    checkServerCompatibility,
} from 'gemdex-core';
import { ClientConfigStore, StoredRemote, tokenEnvVarForRemote } from './cli-config.js';
import { createConfig } from './config.js';
import { createMemoryBackend } from './memory.js';

interface CliIo {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    readSecret: (prompt: string, fromStdin: boolean) => Promise<string>;
}

interface CliDependencies {
    store?: ClientConfigStore;
    io?: CliIo;
    fetch?: typeof fetch;
    createLocalBackend?: () => MemoryBackend;
    createRemoteBackend?: (remote: StoredRemote, token: string) => MemoryBackend;
}

const defaultIo: CliIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
    readSecret,
};

function usage(): string {
    return `Gemdex remote configuration

Usage:
  gemdex init-remote <name> <url> [--token-env VAR | --token-stdin] [--import-local] [--no-activate]
  gemdex remote add <name> <url> [--token-env VAR | --token-stdin]
  gemdex remote list
  gemdex remote remove <name>
  gemdex remote status [name]
  gemdex mode local
  gemdex mode remote <name>
  gemdex status
  gemdex import-local-to-remote [name]

init-remote is the one-shot client setup for a BYOI server: it stores the
remote + token, verifies the server is reachable, authenticated, and version-
compatible, switches Gemdex into remote mode, optionally imports your local
memories (--import-local), and prints the exact agent command to run.
`;
}

function requireArg(args: string[], index: number, label: string): string {
    const value = args[index]?.trim();
    if (!value) throw new Error(`${label} is required.`);
    return value;
}

function optionValue(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    return requireArg(args, index + 1, `${name} value`);
}

async function readSecret(prompt: string, fromStdin: boolean): Promise<string> {
    if (fromStdin) {
        let value = '';
        for await (const chunk of process.stdin) value += chunk;
        return value.replace(/\r?\n$/, '').trim();
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
        throw new Error('Interactive token entry needs a TTY. Use --token-stdin or --token-env VAR.');
    }

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    return new Promise<string>((resolve, reject) => {
        let value = '';
        const cleanup = (): void => {
            process.stdin.off('data', onData);
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdout.write('\n');
        };
        const onData = (chunk: string): void => {
            for (const character of chunk) {
                if (character === '\u0003') {
                    cleanup();
                    reject(new Error('Token entry cancelled.'));
                    return;
                }
                if (character === '\r' || character === '\n') {
                    cleanup();
                    resolve(value.trim());
                    return;
                }
                if (character === '\u007f' || character === '\b') {
                    value = value.slice(0, -1);
                    continue;
                }
                value += character;
            }
        };
        process.stdin.on('data', onData);
    });
}

function resolveRemote(
    store: ClientConfigStore,
    requestedName?: string,
): { name: string; remote: StoredRemote; token: string } {
    const name = requestedName ?? store.getEnv('GEMDEX_REMOTE_NAME');
    if (!name) throw new Error('No remote selected. Pass a remote name or run `gemdex mode remote <name>`.');
    const remote = store.get(name);
    if (!remote) throw new Error(`Remote "${name}" is not configured.`);
    const token = store.getEnv(remote.tokenEnvVar)?.trim();
    if (!token) {
        throw new Error(`Token environment variable "${remote.tokenEnvVar}" is not configured.`);
    }
    return { name, remote, token };
}

async function remoteStatus(
    name: string,
    remote: StoredRemote,
    token: string,
    fetchImpl: typeof fetch,
    createRemoteBackend: (remote: StoredRemote, token: string) => MemoryBackend,
): Promise<{ reachable: boolean; authenticated: boolean; detail?: string }> {
    try {
        const response = await fetchImpl(`${remote.url}/v1/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return { reachable: false, authenticated: false, detail: `health returned HTTP ${response.status}` };
        }
    } catch (error) {
        return {
            reachable: false,
            authenticated: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    }

    try {
        await createRemoteBackend(remote, token).list();
        return { reachable: true, authenticated: true };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { reachable: true, authenticated: false, detail: `${name}: ${detail}` };
    }
}

interface MigrationResult {
    created: number;
    updated: number;
    skipped: number;
}

async function migrateLocalToRemote(
    local: MemoryBackend,
    remote: MemoryBackend,
    io: CliIo,
): Promise<MigrationResult> {
    const records = await local.exportAll();
    const result: MigrationResult = { created: 0, updated: 0, skipped: 0 };
    for (const record of records) {
        try {
            const existed = await remote.get(record.id) !== null;
            const imported = await remote.importRecords([record]);
            if (imported.imported !== 1) {
                result.skipped += 1;
            } else if (existed) {
                result.updated += 1;
            } else {
                result.created += 1;
            }
        } catch (error) {
            result.skipped += 1;
            const detail = error instanceof Error ? error.message : String(error);
            io.stderr(`Skipped ${record.id}: ${detail}\n`);
        }
    }
    return result;
}

/**
 * Verify a Gemdex Server is reachable AND speaks a compatible protocol version
 * before we commit a client to it. Throws a clear, actionable error otherwise.
 * Mirrors the version gate remote clients apply before sending memory data.
 */
async function verifyServerCompatibility(url: string, fetchImpl: typeof fetch): Promise<void> {
    let response: Response;
    try {
        response = await fetchImpl(`${url}/v1/version`, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not reach ${url}/v1/version: ${detail}`);
    }
    if (!response.ok) {
        throw new Error(`${url}/v1/version returned HTTP ${response.status}.`);
    }
    let info: ServerVersionInfo;
    try {
        info = await response.json() as ServerVersionInfo;
    } catch {
        throw new Error(`${url}/v1/version did not return valid JSON.`);
    }
    checkServerCompatibility(info);
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number | null> {
    const store = dependencies.store ?? new ClientConfigStore();
    const io = dependencies.io ?? defaultIo;
    const fetchImpl = dependencies.fetch ?? fetch;
    const createRemoteBackend = dependencies.createRemoteBackend ??
        ((remote: StoredRemote, token: string) => new RemoteMemoryBackend({ url: remote.url, token }));
    const createLocalBackend = dependencies.createLocalBackend ?? (() => {
        const localConfig = createConfig((name) => name === 'GEMDEX_MODE' ? 'local' : store.getEnv(name));
        return createMemoryBackend(localConfig);
    });

    const [command, subcommand] = args;
    const isCliCommand = command === 'remote' ||
        command === 'mode' ||
        command === 'status' ||
        command === 'init-remote' ||
        command === 'import-local-to-remote';
    if (!isCliCommand) return null;

    try {
        if (command === 'remote' && subcommand === 'add') {
            const name = requireArg(args, 2, 'Remote name');
            const url = requireArg(args, 3, 'Remote URL');
            const explicitTokenEnvVar = optionValue(args, '--token-env');
            const fromStdin = args.includes('--token-stdin');
            if (explicitTokenEnvVar && fromStdin) {
                throw new Error('Use either --token-env or --token-stdin, not both.');
            }
            const tokenEnvVar = explicitTokenEnvVar ?? tokenEnvVarForRemote(name);
            if (!explicitTokenEnvVar) {
                const token = await io.readSecret('Bearer token: ', fromStdin);
                if (!token) throw new Error('Bearer token cannot be empty.');
                store.setEnv(tokenEnvVar, token);
            }
            const remote = store.add(name, url, tokenEnvVar);
            io.stdout(`Added remote "${name}" at ${remote.url}.\n`);
            return 0;
        }

        if (command === 'remote' && subcommand === 'list') {
            const activeName = store.getEnv('GEMDEX_MODE') === 'remote'
                ? store.getEnv('GEMDEX_REMOTE_NAME')
                : undefined;
            const remotes = store.list();
            if (remotes.length === 0) {
                io.stdout('No remotes configured.\n');
                return 0;
            }
            for (const remote of remotes) {
                io.stdout(`${remote.name === activeName ? '* ' : '  '}${remote.name}\t${remote.url}\n`);
            }
            return 0;
        }

        if (command === 'remote' && subcommand === 'remove') {
            const name = requireArg(args, 2, 'Remote name');
            if (!store.remove(name)) throw new Error(`Remote "${name}" is not configured.`);
            io.stdout(`Removed remote "${name}".\n`);
            return 0;
        }

        if (command === 'mode' && subcommand === 'local') {
            store.activateLocal();
            io.stdout('Gemdex mode is now local.\n');
            return 0;
        }

        if (command === 'mode' && subcommand === 'remote') {
            const name = requireArg(args, 2, 'Remote name');
            const remote = store.activateRemote(name);
            io.stdout(`Gemdex mode is now remote: ${name} (${remote.url}).\n`);
            return 0;
        }

        if (command === 'status' || (command === 'remote' && subcommand === 'status')) {
            const requestedName = command === 'remote' ? args[2] : undefined;
            const mode = store.getEnv('GEMDEX_MODE')?.toLowerCase() === 'remote' ? 'remote' : 'local';
            if (mode === 'local' && !requestedName) {
                io.stdout('Mode: local\n');
                io.stdout(`Store: ${store.getEnv('LANCEDB_PATH') ?? '~/.gemdex/lance'}\n`);
                return 0;
            }
            const selected = resolveRemote(store, requestedName);
            const status = await remoteStatus(
                selected.name,
                selected.remote,
                selected.token,
                fetchImpl,
                createRemoteBackend,
            );
            io.stdout(`Mode: ${mode}${mode === 'remote' ? ` (${selected.name})` : ''}\n`);
            io.stdout(`Remote: ${selected.remote.url}\n`);
            io.stdout(`Reachable: ${status.reachable ? 'yes' : 'no'}\n`);
            io.stdout(`Authenticated: ${status.authenticated ? 'yes' : 'no'}\n`);
            if (status.detail) io.stdout(`Detail: ${status.detail}\n`);
            return status.reachable && status.authenticated ? 0 : 1;
        }

        if (command === 'init-remote') {
            const name = requireArg(args, 1, 'Remote name');
            const url = requireArg(args, 2, 'Remote URL');
            const explicitTokenEnvVar = optionValue(args, '--token-env');
            const fromStdin = args.includes('--token-stdin');
            const importLocal = args.includes('--import-local');
            const activate = !args.includes('--no-activate');
            if (explicitTokenEnvVar && fromStdin) {
                throw new Error('Use either --token-env or --token-stdin, not both.');
            }

            // 1. Store the named remote and its token (token kept out of config.json).
            const tokenEnvVar = explicitTokenEnvVar ?? tokenEnvVarForRemote(name);
            if (!explicitTokenEnvVar) {
                const token = await io.readSecret('Bearer token: ', fromStdin);
                if (!token) throw new Error('Bearer token cannot be empty.');
                store.setEnv(tokenEnvVar, token);
            }
            const remoteRecord = store.add(name, url, tokenEnvVar);
            io.stdout(`Added remote "${name}" at ${remoteRecord.url}.\n`);

            const token = store.getEnv(tokenEnvVar)?.trim();
            if (!token) {
                throw new Error(`Token environment variable "${tokenEnvVar}" is not configured.`);
            }

            // 2. Fail fast if the server is unreachable or version-incompatible.
            await verifyServerCompatibility(remoteRecord.url, fetchImpl);
            io.stdout('Server reachable and version-compatible.\n');

            // 3. Confirm the token actually authenticates against a data route.
            const remote = createRemoteBackend(remoteRecord, token);
            try {
                await remote.list();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Authentication check failed: ${detail}`);
            }
            io.stdout('Authenticated successfully.\n');

            // 4. Optionally copy this machine's local memories into the remote.
            if (importLocal) {
                const local = createLocalBackend();
                const migration = await migrateLocalToRemote(local, remote, io);
                io.stdout(
                    `Imported local memories — Created: ${migration.created}, ` +
                    `Updated: ${migration.updated}, Skipped: ${migration.skipped}.\n`,
                );
                if (migration.skipped > 0) {
                    io.stderr('Some local memories were skipped; see messages above.\n');
                }
            }

            // 5. Switch this machine into remote mode unless told not to.
            if (activate) {
                store.activateRemote(name);
                io.stdout(`Gemdex mode is now remote: ${name}.\n`);
            }

            io.stdout(
                `\nDone. Point your agent at this remote — e.g. for Claude Code:\n` +
                `  claude mcp add gemdex -- npx -y gemdex-mcp@latest\n` +
                `The MCP process reads the selected remote from ~/.gemdex; ` +
                `no GEMINI_API_KEY is needed on this machine.\n`,
            );
            return 0;
        }

        if (command === 'import-local-to-remote') {
            const selected = resolveRemote(store, args[1]);
            const local = createLocalBackend();
            const remote = createRemoteBackend(selected.remote, selected.token);
            const result = await migrateLocalToRemote(local, remote, io);
            io.stdout(`Migration to "${selected.name}" complete.\n`);
            io.stdout(`Created: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}\n`);
            return result.skipped === 0 ? 0 : 1;
        }

        io.stderr(usage());
        return 1;
    } catch (error) {
        io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}

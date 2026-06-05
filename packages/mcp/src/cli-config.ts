import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StoredRemote {
    url: string;
    tokenEnvVar: string;
}

export interface StoredClientConfig {
    version: 1;
    remotes: Record<string, StoredRemote>;
}

export interface ClientConfigStoreOptions {
    rootDir?: string;
}

function normalizeRemoteName(name: string): string {
    const normalized = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
        throw new Error(
            'Remote name must start with a letter or number and contain only letters, numbers, ".", "_", or "-".',
        );
    }
    return normalized;
}

function normalizeRemoteUrl(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`Remote URL "${value}" is not a valid absolute URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Remote URL must use http or https.');
    }
    return value.replace(/\/+$/, '');
}

function parseConfig(value: unknown): StoredClientConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Gemdex client config must be a JSON object.');
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1 || !candidate.remotes || typeof candidate.remotes !== 'object') {
        throw new Error('Gemdex client config has an unsupported format.');
    }

    const remotes: Record<string, StoredRemote> = {};
    for (const [name, remoteValue] of Object.entries(candidate.remotes as Record<string, unknown>)) {
        if (!remoteValue || typeof remoteValue !== 'object' || Array.isArray(remoteValue)) {
            throw new Error(`Remote "${name}" has an invalid configuration.`);
        }
        const remote = remoteValue as Record<string, unknown>;
        if (typeof remote.url !== 'string' || typeof remote.tokenEnvVar !== 'string') {
            throw new Error(`Remote "${name}" requires string url and tokenEnvVar fields.`);
        }
        remotes[normalizeRemoteName(name)] = {
            url: normalizeRemoteUrl(remote.url),
            tokenEnvVar: remote.tokenEnvVar,
        };
    }
    return { version: 1, remotes };
}

export function tokenEnvVarForRemote(name: string): string {
    const suffix = normalizeRemoteName(name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return `GEMDEX_REMOTE_TOKEN_${suffix}`;
}

export class ClientConfigStore {
    readonly rootDir: string;
    readonly configPath: string;
    readonly envPath: string;

    constructor(options: ClientConfigStoreOptions = {}) {
        this.rootDir = options.rootDir ?? path.join(os.homedir(), '.gemdex');
        this.configPath = path.join(this.rootDir, 'config.json');
        this.envPath = path.join(this.rootDir, '.env');
    }

    load(): StoredClientConfig {
        if (!fs.existsSync(this.configPath)) {
            return { version: 1, remotes: {} };
        }
        try {
            return parseConfig(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Unable to read ${this.configPath}: ${detail}`);
        }
    }

    list(): Array<{ name: string } & StoredRemote> {
        return Object.entries(this.load().remotes)
            .map(([name, remote]) => ({ name, ...remote }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    get(name: string): StoredRemote | null {
        return this.load().remotes[normalizeRemoteName(name)] ?? null;
    }

    add(name: string, url: string, tokenEnvVar: string): StoredRemote {
        const normalizedName = normalizeRemoteName(name);
        const normalizedTokenEnvVar = tokenEnvVar.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedTokenEnvVar)) {
            throw new Error('Token environment variable must be a valid environment variable name.');
        }
        const config = this.load();
        const remote = {
            url: normalizeRemoteUrl(url.trim()),
            tokenEnvVar: normalizedTokenEnvVar,
        };
        config.remotes[normalizedName] = remote;
        this.writeConfig(config);
        return remote;
    }

    remove(name: string): boolean {
        const normalizedName = normalizeRemoteName(name);
        const config = this.load();
        const remote = config.remotes[normalizedName];
        if (!remote) return false;
        delete config.remotes[normalizedName];
        this.writeConfig(config);
        if (remote.tokenEnvVar === tokenEnvVarForRemote(normalizedName)) {
            this.unsetEnv(remote.tokenEnvVar);
        }
        if (this.getEnv('GEMDEX_REMOTE_NAME') === normalizedName) {
            this.setEnv('GEMDEX_MODE', 'local');
        }
        return true;
    }

    activateLocal(): void {
        this.setEnv('GEMDEX_MODE', 'local');
    }

    activateRemote(name: string): StoredRemote {
        const normalizedName = normalizeRemoteName(name);
        const remote = this.get(normalizedName);
        if (!remote) {
            throw new Error(`Remote "${normalizedName}" is not configured.`);
        }
        this.setEnvValues({
            GEMDEX_MODE: 'remote',
            GEMDEX_REMOTE_NAME: normalizedName,
            GEMDEX_REMOTE_URL: remote.url,
            GEMDEX_REMOTE_TOKEN_ENV_VAR: remote.tokenEnvVar,
        });
        return remote;
    }

    getEnv(name: string): string | undefined {
        const processValue = process.env[name];
        if (processValue !== undefined && processValue !== '') return processValue;
        if (!fs.existsSync(this.envPath)) return undefined;
        const line = fs.readFileSync(this.envPath, 'utf8')
            .split(/\r?\n/)
            .find((candidate) => candidate.trimStart().startsWith(`${name}=`));
        return line?.trimStart().slice(name.length + 1);
    }

    setEnv(name: string, value: string): void {
        this.setEnvValues({ [name]: value });
    }

    unsetEnv(name: string): void {
        if (!fs.existsSync(this.envPath)) return;
        const lines = fs.readFileSync(this.envPath, 'utf8')
            .split(/\r?\n/)
            .filter((line) => !line.trimStart().startsWith(`${name}=`))
            .filter((line, index, all) => line !== '' || index < all.length - 1);
        fs.writeFileSync(this.envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(this.envPath, 0o600);
    }

    setEnvValues(values: Record<string, string>): void {
        for (const [name, value] of Object.entries(values)) {
            if (/[\r\n]/.test(value)) {
                throw new Error(`${name} cannot contain a newline.`);
            }
        }
        fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
        const existing = fs.existsSync(this.envPath)
            ? fs.readFileSync(this.envPath, 'utf8').split(/\r?\n/)
            : [];
        const remaining = new Map(Object.entries(values));
        const lines = existing
            .filter((line, index) => line !== '' || index < existing.length - 1)
            .map((line) => {
                const separator = line.indexOf('=');
                if (separator < 1) return line;
                const name = line.slice(0, separator).trim();
                const value = remaining.get(name);
                if (value === undefined) return line;
                remaining.delete(name);
                return `${name}=${value}`;
            });
        for (const [name, value] of remaining) {
            lines.push(`${name}=${value}`);
        }
        fs.writeFileSync(this.envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(this.envPath, 0o600);
    }

    private writeConfig(config: StoredClientConfig): void {
        fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.configPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporaryPath, this.configPath);
        fs.chmodSync(this.configPath, 0o600);
    }
}

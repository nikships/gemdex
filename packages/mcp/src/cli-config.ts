import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorMessage } from './errors.js';

export interface StoredClientConfig {
    version: 1;
    /** Custom folders the user added for chat-history ingestion (absolute paths). */
    ingestFolders?: string[];
    /**
     * Keys written by other Gemdex versions (e.g. `remotes`). Kept verbatim on
     * rewrite so this file never destroys settings it does not own.
     */
    [key: string]: unknown;
}

export interface ClientConfigStoreOptions {
    rootDir?: string;
}

function parseConfig(value: unknown): StoredClientConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Gemdex client config must be a JSON object.');
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1) {
        throw new Error('Gemdex client config has an unsupported format.');
    }
    const ingestFolders = Array.isArray(candidate.ingestFolders)
        ? candidate.ingestFolders.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : undefined;
    const { ingestFolders: _ignored, ...rest } = candidate;
    return { ...rest, version: 1, ...(ingestFolders?.length && { ingestFolders }) };
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
            return { version: 1 };
        }
        try {
            return parseConfig(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
        } catch (error) {
            throw new Error(`Unable to read ${this.configPath}: ${errorMessage(error)}`);
        }
    }

    listIngestFolders(): string[] {
        return this.load().ingestFolders ?? [];
    }

    addIngestFolder(folderPath: string): string[] {
        const normalized = folderPath.trim().replace(/\/+$/, '');
        if (!normalized || !path.isAbsolute(normalized)) {
            throw new Error('Ingest folder must be an absolute path.');
        }
        const config = this.load();
        const folders = config.ingestFolders ?? [];
        if (!folders.includes(normalized)) folders.push(normalized);
        config.ingestFolders = folders;
        this.writeConfig(config);
        return folders;
    }

    removeIngestFolder(folderPath: string): string[] {
        const config = this.load();
        const folders = (config.ingestFolders ?? []).filter((entry) => entry !== folderPath);
        if (folders.length > 0) {
            config.ingestFolders = folders;
        } else {
            delete config.ingestFolders;
        }
        this.writeConfig(config);
        return folders;
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
        // Readers see either the prior configuration or the complete new one.
        const temporaryPath = `${this.envPath}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
            fs.chmodSync(temporaryPath, 0o600);
            fs.renameSync(temporaryPath, this.envPath);
        } finally {
            fs.rmSync(temporaryPath, { force: true });
        }
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

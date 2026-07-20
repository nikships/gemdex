import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HygieneReport } from './types';

/** The on-disk hygiene file shape (`~/.gemdex/hygiene.json`). */
interface HygieneFile {
    version: 1;
    report?: HygieneReport;
    dismissedClusterIds: string[];
}

/**
 * Persistent hygiene state: the latest scan/judge report plus the cluster
 * ids a human has dismissed, stored at `~/.gemdex/hygiene.json`. Dismissals
 * survive across scans because a cluster's id is stable (sha256 of its
 * sorted member ids).
 */
export class HygieneReportStore {
    readonly reportPath: string;

    constructor(options: { rootDir?: string } = {}) {
        const rootDir = options.rootDir ?? path.join(os.homedir(), '.gemdex');
        this.reportPath = path.join(rootDir, 'hygiene.json');
    }

    load(): HygieneFile {
        if (!fs.existsSync(this.reportPath)) {
            return { version: 1, dismissedClusterIds: [] };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.reportPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
                || !Array.isArray(parsed.dismissedClusterIds)) {
                throw new Error('unsupported format');
            }
            return parsed as HygieneFile;
        } catch (error) {
            throw new Error(`Unable to read ${this.reportPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    getReport(): HygieneReport | undefined {
        return this.load().report;
    }

    setReport(report: HygieneReport): void {
        const file = this.load();
        file.report = report;
        this.write(file);
    }

    getDismissed(): Set<string> {
        return new Set(this.load().dismissedClusterIds);
    }

    addDismissed(ids: string[]): void {
        if (ids.length === 0) return;
        const file = this.load();
        const merged = new Set(file.dismissedClusterIds);
        for (const id of ids) merged.add(id);
        file.dismissedClusterIds = Array.from(merged);
        if (file.report) {
            file.report.clusters = file.report.clusters.filter((c) => !merged.has(c.clusterId));
        }
        this.write(file);
    }

    /**
     * Record ids deleted via apply(): append to `deletedIds`, strip those
     * members/findings from the report clusters, and drop any cluster left
     * with fewer than 2 members.
     */
    recordDeleted(ids: string[]): void {
        if (ids.length === 0) return;
        const file = this.load();
        const report = file.report;
        if (!report) return;
        const deleted = new Set(ids);
        for (const id of ids) {
            if (!report.deletedIds.includes(id)) report.deletedIds.push(id);
        }
        report.clusters = report.clusters
            .map((cluster) => ({
                ...cluster,
                members: cluster.members.filter((m) => !deleted.has(m.memoryId)),
                ...(cluster.findings !== undefined && {
                    findings: cluster.findings.filter((f) => !deleted.has(f.memoryId)),
                }),
            }))
            .filter((cluster) => cluster.members.length >= 2);
        this.write(file);
    }

    private write(file: HygieneFile): void {
        fs.mkdirSync(path.dirname(this.reportPath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.reportPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.reportPath);
    }
}

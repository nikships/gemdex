import Foundation
import Combine
import SwiftUI

/// Top-level screen the window should show, derived from the sidecar phase and
/// the local store config.
enum AppScreen: Equatable {
    case launching
    case setup                         // sidecar ready, local embedding model not installed
    case ready                         // memories loaded
    case needsNode
    case needsBootstrap(previouslyInstalled: Bool, detail: String)
    case installing(detail: String)
    case sidecarFailed(detail: String)
}

/// Sidebar search state. `.idle` shows the local title filter / full list;
/// `.results` holds the relevance-ranked recall hits from `POST /recall`.
enum SearchState: Equatable {
    case idle
    case searching
    case results([RecallResult])
    case failed(String)
}

/// Live import progress for the banner shown while a file imports; nil when
/// no import is running. Prefer `importActivity` / the Activity Center; this
/// remains as a thin convenience mirror for callers that only need counts.
struct ImportProgress: Equatable {
    var completed: Int
    var total: Int
}

/// End-of-import alert payload (success / partial / failure).
struct ImportAlert: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
}

/// Central observable app state. Owns the sidecar lifecycle, the API client,
/// and all loaded memory/config/settings state. Views read from here and call
/// its async methods; it never reaches around the sidecar for store access.
@MainActor
final class AppModel: ObservableObject {
    @Published var screen: AppScreen = .launching
    @Published var statusText: String = "Starting…"
    @Published var statusIsError: Bool = false

    @Published var memories: [MemorySummary] = []
    @Published var filterText: String = ""
    @Published var selectedID: String?

    @Published private(set) var config: ConfigSummary?
    @Published private(set) var embeddingStatus: EmbeddingStatus?
    @Published private(set) var embeddingError: String?
    @Published private(set) var embeddingRequestPending = false

    /// True while a `POST /config/check` Claude Code re-probe is in flight.
    @Published private(set) var claudeCodeCheckPending = false
    @Published private(set) var claudeCodeError: String?

    @Published var isEditorOpen = false
    @Published var showSettings = false
    @Published var showIngest = false
    @Published var showHygiene = false

    /// Semantic free-text search state (`.idle` = local title filter).
    @Published var searchState: SearchState = .idle

    /// Non-nil while an import is running (drives the progress banner and
    /// disables the Import button); the alert fires once when it finishes.
    @Published var importProgress: ImportProgress?
    @Published var importAlert: ImportAlert?

    // MARK: Activity Center
    // Long-running jobs (ingest / hygiene / import / local model) are owned here
    // so closing a panel never loses progress. The Activity rail on MainView
    // renders these; panels re-hydrate from them on reopen.

    /// Live + brief terminal snapshots for every tracked job kind.
    @Published private(set) var activities: [JobKind: JobActivity] = [:]
    /// Last polled ingest status (panels read this instead of owning a poll).
    @Published private(set) var ingestStatus: IngestStatus?
    /// Last polled hygiene status.
    @Published private(set) var hygieneStatus: HygieneStatus?

    let editor = EditorModel()
    let sidecar = SidecarManager()
    private(set) var api: APIClient?
    private var cancellables = Set<AnyCancellable>()

    /// Background poll of sidecar job status. Fast while active, slow when idle.
    private var activityPollTask: Task<Void, Never>?
    /// Polls `GET /config` while the sidecar's Claude Code probe is `checking`.
    private var claudeCodePollTask: Task<Void, Never>?
    /// Cooperative cancel for client-side import batches.
    private var importCancelRequested = false
    /// Prevent double-complete UI when a panel and the poller both see "done".
    private var lastIngestTerminalSignature: String?
    private var lastHygieneTerminalSignature: String?
    /// Auto-dismiss terminal activity chips after this many seconds.
    private static let terminalDismissSeconds: TimeInterval = 12

    var visibleMemories: [MemorySummary] {
        let query = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return memories }
        // Match displayTitle so empty-title memories ("Untitled memory") filter
        // consistently with how they render.
        return memories.filter { $0.searchTitle.contains(query) }
    }

    /// Recall hits joined back to loaded summaries, preserving recall order so
    /// the sidebar can render ranked results with the normal `MemoryRow`.
    func resultSummaries(_ results: [RecallResult]) -> [MemorySummary] {
        let byID = Dictionary(memories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return results.compactMap { byID[$0.id] }
    }

    init() {
        editor.appModel = self
        sidecar.$phase
            .receive(on: RunLoop.main)
            .sink { [weak self] phase in
                self?.handle(phase: phase)
            }
            .store(in: &cancellables)
    }

    func start() {
        sidecar.start()
    }

    func stop() {
        sidecar.stop()
    }

    // MARK: - Phase handling

    private func handle(phase: SidecarPhase) {
        switch phase {
        case .starting:
            screen = .launching
            statusText = "Waiting for memory store…"
            statusIsError = false
        case let .ready(base, token):
            if let api {
                Task { await api.update(baseURL: base, token: token) }
            } else {
                api = APIClient(baseURL: base, token: token)
            }
            Task { await syncConfigGate() }
        case .needsNode:
            screen = .needsNode
            statusText = "Node.js is required"
            statusIsError = true
        case let .needsBootstrap(installed, detail):
            screen = .needsBootstrap(previouslyInstalled: installed, detail: detail)
            statusText = "Setup required"
            statusIsError = true
        case let .installing(detail):
            screen = .installing(detail: detail)
            statusText = "Setting up…"
            statusIsError = false
        case let .failed(detail):
            screen = .sidecarFailed(detail: detail)
            statusText = "Setup failed"
            statusIsError = true
        }
    }

    /// The memory UI is gated only on `configured` (local embedding model
    /// installed). Claude Code readiness gates ingest + hygiene, never the store.
    @discardableResult
    func syncConfigGate() async -> Bool {
        guard let api else { return false }
        do {
            let cfg = try await api.config()
            apply(config: cfg)

            if cfg.configured {
                await loadMemories()
                return true
            }
            showSetup()
            return false
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
            return false
        }
    }

    private func apply(config cfg: ConfigSummary) {
        config = cfg
        let wasRunning = embeddingStatus?.isRunning == true || activities[.embedding]?.isActive == true
        if !embeddingRequestPending && (cfg.embedding.isRunning || !wasRunning) {
            embeddingStatus = cfg.embedding
            if cfg.embedding.isRunning {
                trackRunningEmbedding(cfg.embedding)
            }
        }
        if cfg.claudeCode.isChecking {
            startClaudeCodePolling()
        }
    }

    private func showSetup() {
        isEditorOpen = false
        showIngest = false
        showHygiene = false
        showSettings = false
        screen = .setup
        if embeddingStatus?.isRunning == true {
            setStatus("Installing the local embedding model…")
        } else {
            setStatus("Local embedding model not installed", isError: true)
        }
    }

    func loadMemories() async {
        guard let api else { return }
        do {
            let list = try await api.listMemories()
            self.memories = list
            screen = .ready
            setStatus(Self.countLabel(list.count))
            // Pick up any in-flight sidecar job and keep the Activity Center
            // polling for the rest of the session.
            await refreshActivityStatus()
            startActivityMonitoring()
        } catch let err as APIError where err.needsInstall {
            await refreshConfig()
            showSetup()
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    /// Route back to the install screen when a memory route reports the local
    /// model is missing (`503 {needsInstall: true}`). Returns `true` if handled.
    @discardableResult
    func handleNeedsInstall(_ error: Error) -> Bool {
        guard let err = error as? APIError, err.needsInstall else { return false }
        Task {
            await refreshConfig()
            showSetup()
        }
        return true
    }

    func refreshList() async {
        guard let api else { return }
        if let list = try? await api.listMemories() {
            self.memories = list
            setStatus(Self.countLabel(list.count))
        }
    }

    // MARK: - Memory actions

    func openNew() {
        selectedID = nil
        editor.startNew()
        showSettings = false
        showIngest = false
        showHygiene = false
        isEditorOpen = true
    }

    func openMemory(_ id: String) async {
        guard let api else { return }
        do {
            let memory = try await api.getMemory(id)
            selectedID = memory.id
            editor.load(memory)
            showSettings = false
            showIngest = false
            showHygiene = false
            isEditorOpen = true
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    func deleteSelected() async {
        guard let api, let id = selectedID else { return }
        do {
            try await api.deleteMemory(id)
            selectedID = nil
            isEditorOpen = false
            await refreshList()
            setStatus("Deleted.")
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    // MARK: - Search

    /// Run semantic free-text recall for the current `filterText`. An empty
    /// query resets to the local-filter idle state; otherwise the sidecar
    /// embeds the query and returns the parent-document hybrid ranking.
    func runSearch() async {
        guard let api else { return }
        let query = filterText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchState = .idle
            return
        }
        searchState = .searching
        do {
            let results = try await api.recallByText(query: query)
            // Drop stale results if the user edited the query while loading.
            guard filterText.trimmingCharacters(in: .whitespacesAndNewlines) == query else { return }
            searchState = .results(results)
        } catch let err as APIError {
            if handleNeedsInstall(err) {
                searchState = .idle
                return
            }
            searchState = .failed(err.message)
            setStatus("Search failed: \(err.message)", isError: true)
        } catch {
            searchState = .failed(error.localizedDescription)
            setStatus("Search failed: \(error.localizedDescription)", isError: true)
        }
    }

    func clearSearch() {
        filterText = ""
        searchState = .idle
    }

    // MARK: - Export / import

    func exportAll(to url: URL) async {
        guard let api else { return }
        do {
            let records = try await api.exportAll()
            // Encode + write off the main thread so a large export can't stutter.
            try await Task.detached(priority: .userInitiated) {
                let encoder = JSONEncoder()
                let lines = try records.map { String(data: try encoder.encode($0), encoding: .utf8) ?? "" }
                let data = Data(lines.joined(separator: "\n").utf8)
                try data.write(to: url, options: .atomic)
            }.value
            setStatus("Exported \(records.count) memories.")
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    func importFile(_ url: URL) async {
        guard let api else {
            importAlert = ImportAlert(
                title: "Import unavailable",
                message: "The memory store isn't ready yet. Try again in a moment."
            )
            return
        }
        // One import at a time — the Activity Center and toolbar share this gate.
        if activities[.importFile]?.isActive == true { return }

        let batches: [[Any]]
        do {
            // Read + parse + batch off the main thread; the network import runs here.
            batches = try await Task.detached(priority: .userInitiated) {
                let text = try String(contentsOf: url, encoding: .utf8)
                return try Self.batchImportRecords(Self.parseImport(text))
            }.value
        } catch {
            importAlert = ImportAlert(title: "Import failed", message: error.localizedDescription)
            setStatus("Import failed: \(error.localizedDescription)", isError: true)
            return
        }
        let total = batches.reduce(0) { $0 + $1.count }
        guard total > 0 else {
            importAlert = ImportAlert(
                title: "Nothing to import",
                message: "The selected file doesn't contain any memory records."
            )
            return
        }

        // Import in batches so a large file shows real progress and one bad
        // batch can't sink the whole import. The server is additionally
        // per-record fault-tolerant within each batch. Cancel is cooperative
        // between batches (a in-flight POST still finishes).
        importCancelRequested = false
        importProgress = ImportProgress(completed: 0, total: total)
        upsertActivity(.running(
            kind: .importFile,
            title: "Importing memories",
            completed: 0,
            total: total,
            detail: "Re-embedding each record",
            canCancel: true,
            canOpen: false
        ))
        defer {
            importProgress = nil
            importCancelRequested = false
        }
        var imported = 0
        var failedCount = 0
        var failureDetails: [String] = []
        var processed = 0
        var wasCancelled = false
        for batch in batches {
            if importCancelRequested {
                wasCancelled = true
                break
            }
            do {
                let payload = try JSONSerialization.data(withJSONObject: ["records": batch])
                let result = try await api.importRecords(payload)
                imported += result.imported
                failedCount += result.failed ?? 0
                failureDetails.append(contentsOf: (result.errors ?? []).map(\.error))
            } catch {
                failedCount += batch.count
                failureDetails.append("\(batch.count) records: \(error.localizedDescription)")
            }
            processed += batch.count
            importProgress = ImportProgress(completed: processed, total: total)
            upsertActivity(.running(
                kind: .importFile,
                title: "Importing memories",
                completed: processed,
                total: total,
                detail: "\(imported) saved" + (failedCount > 0 ? " · \(failedCount) failed" : ""),
                canCancel: true,
                canOpen: false
            ))
            setStatus("Importing \(processed) of \(total) memories…")
        }

        await refreshList()
        if wasCancelled {
            setStatus("Import cancelled — \(imported) of \(total) saved.")
            finishActivity(
                kind: .importFile,
                phase: .cancelled,
                title: "Import cancelled",
                detail: "\(imported) of \(total) memories saved before cancel",
                completed: processed,
                total: total
            )
            importAlert = ImportAlert(
                title: "Import cancelled",
                message: "Saved \(imported) of \(total) memories before cancel."
            )
        } else if failedCount == 0 {
            setStatus("Imported \(imported) \(imported == 1 ? "memory" : "memories").")
            finishActivity(
                kind: .importFile,
                phase: .completed,
                title: "Import complete",
                detail: "\(imported) \(imported == 1 ? "memory" : "memories") saved",
                completed: total,
                total: total
            )
            importAlert = ImportAlert(
                title: "Import complete",
                message: "Imported \(imported) \(imported == 1 ? "memory" : "memories")."
            )
        } else {
            let sample = failureDetails.prefix(3).joined(separator: "\n")
            setStatus("Imported \(imported) of \(total) memories (\(failedCount) failed)", isError: true)
            finishActivity(
                kind: .importFile,
                phase: imported > 0 ? .completed : .failed,
                title: imported > 0 ? "Import partially complete" : "Import failed",
                detail: "\(imported) of \(total) saved · \(failedCount) failed",
                completed: processed,
                total: total,
                error: sample
            )
            importAlert = ImportAlert(
                title: imported > 0 ? "Import partially complete" : "Import failed",
                message: "Imported \(imported) of \(total) memories; \(failedCount) failed.\n\n\(sample)"
            )
        }
    }

    /// Split parsed records into POST-sized batches so a large import reports
    /// real progress and a single failure can't sink the whole file. Batches
    /// cap at a record count or a serialized byte budget, whichever comes
    /// first (kept well under the sidecar's 100 MiB import body limit).
    /// Pure + nonisolated so it can run on a detached background task.
    nonisolated private static func batchImportRecords(_ records: [Any]) throws -> [[Any]] {
        let recordLimit = 25
        let byteLimit = 24 * 1024 * 1024
        var batches: [[Any]] = []
        var current: [Any] = []
        var currentBytes = 0
        for record in records {
            let recordBytes = try JSONSerialization.data(withJSONObject: record).count
            if !current.isEmpty && (current.count >= recordLimit || currentBytes + recordBytes > byteLimit) {
                batches.append(current)
                current = []
                currentBytes = 0
            }
            current.append(record)
            currentBytes += recordBytes
        }
        if !current.isEmpty { batches.append(current) }
        return batches
    }

    /// Accept either a JSON array or JSONL (one record per line). Pure +
    /// nonisolated so it can run on a detached background task.
    nonisolated private static func parseImport(_ text: String) throws -> [Any] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return [] }
        if trimmed.hasPrefix("[") {
            return (try JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [Any]) ?? []
        }
        return try trimmed.split(separator: "\n").compactMap { line -> Any? in
            // Trim newlines too so Windows CRLF (\r\n) files don't leave a
            // trailing \r that breaks JSON parsing.
            let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return nil }
            return try JSONSerialization.jsonObject(with: Data(t.utf8))
        }
    }

    // MARK: - Activity Center

    /// Active + terminal activities ordered for the rail (active first, newest last).
    var activityList: [JobActivity] {
        let order: [JobKind] = [.ingest, .hygiene, .importFile, .embedding]
        return order.compactMap { activities[$0] }
    }

    var hasActiveActivities: Bool {
        activities.values.contains(where: \.isActive)
    }

    var ingestIsActive: Bool { activities[.ingest]?.isActive == true }
    var hygieneIsActive: Bool { activities[.hygiene]?.isActive == true }
    var importIsActive: Bool { activities[.importFile]?.isActive == true }

    /// Convenience mirror used by the legacy import banner path.
    var importActivity: JobActivity? { activities[.importFile] }

    /// Jump into the panel for a job (or dismiss settings/editor first).
    func openActivity(_ kind: JobKind) {
        switch kind {
        case .ingest:
            showSettings = false
            showHygiene = false
            isEditorOpen = false
            showIngest = true
        case .hygiene:
            showSettings = false
            showIngest = false
            isEditorOpen = false
            showHygiene = true
        case .importFile:
            // Import has no dedicated panel; keep the user on the main list.
            break
        case .embedding:
            guard screen == .ready else { return }
            showIngest = false
            showHygiene = false
            isEditorOpen = false
            showSettings = true
        }
    }

    /// Cooperative / sidecar cancel for the given job kind.
    func cancelActivity(_ kind: JobKind) {
        switch kind {
        case .importFile:
            importCancelRequested = true
            if var current = activities[.importFile], current.isActive {
                current.phase = .cancelling
                current.canCancel = false
                current.detail = "Cancelling after this batch…"
                current.updatedAt = Date()
                activities[.importFile] = current
            }
        case .ingest:
            Task { await cancelIngest() }
        case .hygiene:
            Task { await cancelHygiene() }
        case .embedding:
            // The sidecar exposes no cancel for install/migrate jobs.
            break
        }
    }

    /// Dismiss a terminal (completed/failed/cancelled) activity chip.
    func dismissActivity(_ kind: JobKind) {
        guard let job = activities[kind], job.isTerminal else { return }
        activities[kind] = nil
    }

    /// Called by IngestView right after `POST /ingest/start` succeeds so the
    /// rail lights up even before the first poll returns.
    func noteIngestStarted(total hintTotal: Int = 0) {
        lastIngestTerminalSignature = nil
        upsertActivity(.running(
            kind: .ingest,
            title: "Ingesting chat history",
            completed: 0,
            total: hintTotal,
            detail: "Starting…",
            canCancel: true,
            canOpen: true
        ))
        startActivityMonitoring()
    }

    /// Called by HygieneView right after `POST /hygiene/start` succeeds.
    func noteHygieneStarted(total hintTotal: Int = 0) {
        lastHygieneTerminalSignature = nil
        upsertActivity(.running(
            kind: .hygiene,
            title: "Analyzing memories",
            completed: 0,
            total: hintTotal,
            detail: "Starting…",
            canCancel: true,
            canOpen: true
        ))
        startActivityMonitoring()
    }

    /// One-shot refresh of ingest + hygiene + local model status into the
    /// Activity Center. Ingest/hygiene are skipped until the store is mounted.
    func refreshActivityStatus() async {
        guard let api else { return }
        if config?.configured == true {
            async let ingest = try? api.ingestStatus()
            async let hygiene = try? api.hygieneStatus()
            let ingestLatest = await ingest
            let hygieneLatest = await hygiene
            if let ingestLatest {
                applyIngestStatus(ingestLatest)
            }
            if let hygieneLatest {
                applyHygieneStatus(hygieneLatest)
            }
        }
        if !embeddingRequestPending && (embeddingStatus?.isRunning == true || activities[.embedding]?.isActive == true) {
            await refreshEmbeddingStatus()
        }
    }

    private func startActivityMonitoring() {
        guard activityPollTask == nil else { return }
        activityPollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshActivityStatus()
                self.pruneStaleTerminalActivities()
                // Poll fast while something is running; slow while only
                // terminal chips remain so auto-dismiss still runs.
                let active = self.activities.values.contains(where: \.isActive)
                let hasTerminal = self.activities.values.contains(where: \.isTerminal)
                let nanos: UInt64
                if active {
                    nanos = 1_000_000_000
                } else if hasTerminal {
                    nanos = 3_000_000_000
                } else {
                    // Nothing to track — stop the loop; note*Started restarts it.
                    self.activityPollTask = nil
                    return
                }
                try? await Task.sleep(nanoseconds: nanos)
            }
        }
    }

    private func cancelIngest() async {
        guard let api else { return }
        if var current = activities[.ingest], current.isActive {
            current.phase = .cancelling
            current.canCancel = false
            current.detail = "Cancelling… already-saved digests are kept"
            current.updatedAt = Date()
            activities[.ingest] = current
        }
        do {
            try await api.ingestCancel()
            // Cancel is cooperative; the poller picks up the terminal state.
            await refreshActivityStatus()
        } catch {
            setStatus("Cancel failed: \(error.localizedDescription)", isError: true)
        }
    }

    private func cancelHygiene() async {
        guard let api else { return }
        if var current = activities[.hygiene], current.isActive {
            current.phase = .cancelling
            current.canCancel = false
            current.detail = "Cancelling… partial findings are kept"
            current.updatedAt = Date()
            activities[.hygiene] = current
        }
        do {
            try await api.hygieneCancel()
            await refreshActivityStatus()
        } catch {
            setStatus("Cancel failed: \(error.localizedDescription)", isError: true)
        }
    }

    private func applyIngestStatus(_ status: IngestStatus) {
        ingestStatus = status

        switch status.state {
        case "running":
            lastIngestTerminalSignature = nil
            let done = status.processed + status.failed
            var detail = "\(status.processed) ingested · \(status.failed) failed · \(status.total) total"
            if let current = status.currentFile, !current.isEmpty {
                let name = (current as NSString).lastPathComponent
                detail += " · \(name)"
            }
            upsertActivity(.running(
                kind: .ingest,
                title: "Ingesting chat history",
                completed: done,
                total: status.total,
                detail: detail,
                canCancel: true,
                canOpen: true
            ))

        case "done", "failed", "cancelled":
            let signature = "\(status.state):\(status.processed):\(status.failed):\(status.total):\(status.error ?? "")"
            guard signature != lastIngestTerminalSignature else { return }
            lastIngestTerminalSignature = signature
            // Only surface a terminal chip if we were already tracking this run.
            // A cold-start poll of a leftover "done" status must not flash a banner.
            let wasTracking = activities[.ingest]?.isActive == true
                || activities[.ingest]?.phase == .cancelling
            guard wasTracking else { return }
            let phase: JobPhase = status.state == "done" ? .completed
                : status.state == "cancelled" ? .cancelled : .failed
            let title: String
            switch phase {
            case .completed: title = "Ingestion complete"
            case .cancelled: title = "Ingestion cancelled"
            default: title = "Ingestion failed"
            }
            let detail = "\(status.processed) saved" + (status.failed > 0 ? " · \(status.failed) failed" : "")
            finishActivity(
                kind: .ingest,
                phase: phase,
                title: title,
                detail: status.error ?? detail,
                completed: status.processed + status.failed,
                total: max(status.total, status.processed + status.failed),
                error: status.error
            )
            if phase == .completed || phase == .cancelled {
                Task { await refreshList() }
            }
            if phase == .completed {
                setStatus("Ingested \(status.processed) \(status.processed == 1 ? "memory" : "memories").")
            } else if phase == .failed {
                setStatus("Ingestion failed: \(status.error ?? "unknown error")", isError: true)
            } else {
                setStatus("Ingestion cancelled — \(status.processed) saved.")
            }

        default:
            // idle — drop an active chip only if we thought something was running
            // and the sidecar went quiet without a terminal state (unlikely).
            break
        }
    }

    private func applyHygieneStatus(_ status: HygieneStatus) {
        hygieneStatus = status

        switch status.state {
        case "running":
            lastHygieneTerminalSignature = nil
            let done = status.judged + status.failed
            upsertActivity(.running(
                kind: .hygiene,
                title: "Analyzing memories",
                completed: done,
                total: status.total,
                detail: "\(status.judged) judged · \(status.failed) failed · \(status.total) clusters",
                canCancel: true,
                canOpen: true
            ))

        case "done", "failed", "cancelled":
            let signature = "\(status.state):\(status.judged):\(status.failed):\(status.total):\(status.error ?? "")"
            guard signature != lastHygieneTerminalSignature else { return }
            lastHygieneTerminalSignature = signature
            let wasTracking = activities[.hygiene]?.isActive == true
                || activities[.hygiene]?.phase == .cancelling
            guard wasTracking else { return }
            let phase: JobPhase = status.state == "done" ? .completed
                : status.state == "cancelled" ? .cancelled : .failed
            let title: String
            switch phase {
            case .completed: title = "Hygiene analysis complete"
            case .cancelled: title = "Hygiene analysis cancelled"
            default: title = "Hygiene analysis failed"
            }
            let detail = "\(status.judged) clusters judged" + (status.failed > 0 ? " · \(status.failed) failed" : "")
            finishActivity(
                kind: .hygiene,
                phase: phase,
                title: title,
                detail: status.error ?? detail,
                completed: status.judged + status.failed,
                total: max(status.total, status.judged + status.failed),
                error: status.error
            )
            if phase == .completed {
                setStatus("Hygiene analysis complete — review findings.")
            } else if phase == .failed {
                setStatus("Hygiene failed: \(status.error ?? "unknown error")", isError: true)
            } else {
                setStatus("Hygiene cancelled — partial findings kept.")
            }

        default:
            break
        }
    }

    private func upsertActivity(_ job: JobActivity) {
        var next = job
        next.updatedAt = Date()
        activities[job.kind] = next
    }

    private func finishActivity(
        kind: JobKind,
        phase: JobPhase,
        title: String,
        detail: String?,
        completed: Int,
        total: Int,
        error: String? = nil
    ) {
        let fraction: Double? = total > 0 ? Double(min(completed, total)) / Double(total) : nil
        activities[kind] = JobActivity(
            kind: kind,
            phase: phase,
            title: title,
            detail: detail,
            completed: completed,
            total: total,
            fraction: fraction,
            canCancel: false,
            canOpen: kind == .ingest || kind == .hygiene || kind == .embedding,
            error: error,
            updatedAt: Date()
        )
        // Keep the poller alive briefly so auto-dismiss runs.
        startActivityMonitoring()
    }

    private func pruneStaleTerminalActivities() {
        let cutoff = Date().addingTimeInterval(-Self.terminalDismissSeconds)
        for (kind, job) in activities where job.isTerminal && job.updatedAt < cutoff {
            activities[kind] = nil
        }
    }

    // MARK: - Config

    func refreshConfig() async {
        guard let api else { return }
        if let cfg = try? await api.config() {
            apply(config: cfg)
        }
    }

    // MARK: - Claude Code readiness

    var claudeCode: ClaudeCodeReadiness? { config?.claudeCode }
    /// Ingestion digests with the local Claude Code CLI.
    var ingestionIsReady: Bool { config?.claudeCode.isReady ?? false }
    /// Hygiene judging uses the same Claude Code CLI as ingestion.
    var hygieneIsReady: Bool { ingestionIsReady }
    var claudeCodeIsChecking: Bool { claudeCodeCheckPending || (config?.claudeCode.isChecking ?? false) }

    /// Explicit re-probe (`POST /config/check`). The sidecar waits for the
    /// probe, so the response carries a settled status.
    func checkClaudeCode() async {
        guard let api, !claudeCodeCheckPending else { return }
        claudeCodeCheckPending = true
        claudeCodeError = nil
        defer { claudeCodeCheckPending = false }
        do {
            let cfg = try await api.checkClaudeCode()
            apply(config: cfg)
        } catch {
            claudeCodeError = error.localizedDescription
        }
    }

    /// Adopt a fresher readiness snapshot carried by another route
    /// (`GET /ingest/sources` includes `claudeCode`).
    func noteClaudeCode(_ readiness: ClaudeCodeReadiness) {
        guard var cfg = config, cfg.claudeCode != readiness else { return }
        cfg.claudeCode = readiness
        config = cfg
        if readiness.isChecking { startClaudeCodePolling() }
    }

    /// Poll `GET /config` while the sidecar reports `checking` (500 ms, ≈30 s max).
    private func startClaudeCodePolling() {
        guard claudeCodePollTask == nil else { return }
        claudeCodePollTask = Task { [weak self] in
            for _ in 0..<60 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, !Task.isCancelled else { return }
                guard let api = self.api, let cfg = try? await api.config() else { continue }
                self.config = cfg
                if !cfg.claudeCode.isChecking { break }
            }
            self?.claudeCodePollTask = nil
        }
    }

    // MARK: - Backend badge

    var backendLabel: String {
        guard let config else { return "Local: loading…" }
        switch embeddingStatus?.status ?? config.embedding.status {
        case "installing": return "Local: installing model"
        case "migrating": return "Local: migrating memories"
        case "error": return "Local: model error"
        case "not-installed": return "Local: model not installed"
        default: return config.configured ? "Local: BGE-M3 (MLX)" : "Local: model not installed"
        }
    }

    var backendNeedsAttention: Bool {
        guard let config else { return true }
        return !config.configured || (embeddingStatus?.status ?? config.embedding.status) == "error"
    }

    // MARK: - Local embedding model

    var embeddingIsBusy: Bool {
        embeddingRequestPending || embeddingStatus?.isRunning == true || activities[.embedding]?.isActive == true
    }

    private func trackRunningEmbedding(_ state: EmbeddingStatus) {
        upsertActivity(.running(
            kind: .embedding,
            title: state.status == "installing" ? "Installing local embedding model" : "Migrating memories to the local model",
            completed: state.completed ?? 0,
            total: state.total ?? 0,
            detail: state.message,
            canCancel: false,
            // Settings is reachable only once the store is mounted; the setup
            // screen shows install progress inline.
            canOpen: screen == .ready
        ))
        startActivityMonitoring()
    }

    func refreshEmbeddingStatus() async {
        guard let api else { return }
        do {
            let previous = embeddingStatus
            let wasRunning = previous?.isRunning == true || activities[.embedding]?.isActive == true
            let wasMigrating = previous?.status == "migrating"
            let latest = try await api.embeddingStatus()
            embeddingStatus = latest
            embeddingError = nil
            if latest.isRunning {
                trackRunningEmbedding(latest)
            } else if wasRunning {
                let failed = latest.status == "error"
                let job = wasMigrating ? "Migration" : "Local model install"
                // The finished status may omit counters; keep the last polled ones.
                let total = latest.total ?? previous?.total ?? 0
                let completed = latest.completed ?? (failed ? previous?.completed ?? 0 : total)
                finishActivity(kind: .embedding, phase: failed ? .failed : .completed,
                               title: failed ? "\(job) failed" : "\(job) complete",
                               detail: latest.message, completed: completed, total: total,
                               error: failed ? latest.message : nil)
                await syncConfigGate()
            }
        } catch {
            // Do not retry a POST after a lost response: keep polling the job.
            embeddingError = error.localizedDescription
        }
    }

    enum EmbeddingJob { case install, migrate }

    /// Explicit, user-confirmed install or legacy-memory migration. Both
    /// answer `202` with a running `EmbeddingStatus` and are polled through
    /// `GET /settings/embedding`; `409` means a job is already running.
    func startEmbeddingJob(_ job: EmbeddingJob) async {
        guard let api, !embeddingIsBusy else { return }
        if job == .migrate && legacyMemoryCount == 0 { return }
        embeddingRequestPending = true
        embeddingError = nil
        defer { embeddingRequestPending = false }
        do {
            let latest: EmbeddingStatus
            switch job {
            case .install: latest = try await api.installEmbedding()
            case .migrate: latest = try await api.migrateEmbedding()
            }
            embeddingStatus = latest
            if latest.isRunning {
                trackRunningEmbedding(latest)
            } else {
                await syncConfigGate()
            }
        } catch {
            embeddingError = error.localizedDescription
            // An HTTP status is definitive (409 included: poll the running job);
            // transport/decode errors can follow acceptance, so reconcile
            // status without resubmitting the action.
            let status = (error as? APIError)?.status ?? -1
            if status == -1 || status == 409 {
                upsertActivity(.indeterminate(kind: .embedding, title: "Checking local embedding job", detail: embeddingError))
                startActivityMonitoring()
            }
        }
    }

    /// Memories still in the legacy Gemini index (0 when none or unknown).
    var legacyMemoryCount: Int {
        guard let state = embeddingStatus, state.installed else { return 0 }
        return state.legacyMemories ?? 0
    }

    func setStatus(_ text: String, isError: Bool = false) {
        statusText = text
        statusIsError = isError
    }

    private static func countLabel(_ count: Int) -> String {
        "\(count) \(count == 1 ? "memory" : "memories")"
    }
}

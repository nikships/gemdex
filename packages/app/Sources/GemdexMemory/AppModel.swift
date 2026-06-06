import Foundation
import Combine
import SwiftUI

/// Top-level screen the window should show, derived from the sidecar phase and
/// the active backend config. Mirrors the web app's gate/recovery states.
enum AppScreen: Equatable {
    case launching
    case setup                         // sidecar ready, no API key configured
    case ready                         // memories loaded
    case needsNode
    case needsBootstrap(previouslyInstalled: Bool, detail: String)
    case installing(detail: String)
    case sidecarFailed(detail: String)
    case remoteUnavailable(detail: String)
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

    @Published var config: ConfigSummary?
    @Published var settings: SettingsSummary?

    @Published var isEditorOpen = false
    @Published var showSettings = false

    /// Recall-by-example panel state (nil = hidden).
    @Published var similar: SimilarState?

    let editor = EditorModel()
    let sidecar = SidecarManager()
    private(set) var api: APIClient?
    private var cancellables = Set<AnyCancellable>()

    struct SimilarState: Equatable {
        var title: String
        var results: [RecallResult]
        var errorMessage: String?
        var loading: Bool
    }

    var visibleMemories: [MemorySummary] {
        let query = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return memories }
        // Match displayTitle so empty-title memories ("Untitled memory") filter
        // consistently with how they render.
        return memories.filter { $0.displayTitle.lowercased().contains(query) }
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

    /// Reconcile UI with the sidecar's config: load memories when a key is set,
    /// otherwise reveal the setup screen.
    @discardableResult
    func syncConfigGate() async -> Bool {
        guard let api else { return false }
        do {
            let cfg = try await api.config()
            self.config = cfg
            if cfg.configured {
                await loadMemories()
                return true
            }
            screen = .setup
            statusText = "API key required"
            return false
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
            return false
        }
    }

    func loadMemories() async {
        guard let api else { return }
        do {
            let list = try await api.listMemories()
            self.memories = list
            screen = .ready
            setStatus(Self.countLabel(list.count))
        } catch let err as APIError {
            if config?.mode == "remote" {
                screen = .remoteUnavailable(detail: err.message)
                setStatus("Remote unavailable: \(err.message)", isError: true)
            } else {
                setStatus("Error: \(err.message)", isError: true)
            }
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
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
        similar = nil
        isEditorOpen = true
    }

    func openMemory(_ id: String) async {
        guard let api else { return }
        do {
            let memory = try await api.getMemory(id)
            selectedID = memory.id
            editor.load(memory)
            similar = nil
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

    func findSimilar(to attachment: EditorAttachment) async {
        guard let api, let memoryID = selectedID,
              case let .existing(attachmentId) = attachment.source else { return }
        similar = SimilarState(title: "Finding similar memories…", results: [], errorMessage: nil, loading: true)
        do {
            let bytes = try await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentId)
            let results = try await api.recallByMedia(mimeType: bytes.mimeType, base64: bytes.data.base64EncodedString())
                .filter { $0.id != memoryID }
            // Drop results if the user switched memories while we were loading.
            guard selectedID == memoryID else { return }
            similar = SimilarState(title: "Similar memories", results: results, errorMessage: nil, loading: false)
        } catch {
            guard selectedID == memoryID else { return }
            similar = SimilarState(title: "Find similar needs attention", results: [], errorMessage: error.localizedDescription, loading: false)
            setStatus("Find similar failed: \(error.localizedDescription)", isError: true)
        }
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
        guard let api else { return }
        do {
            // Read + parse off the main thread; the network import stays here.
            let payload = try await Task.detached(priority: .userInitiated) {
                let text = try String(contentsOf: url, encoding: .utf8)
                let records = try Self.parseImport(text)
                return try JSONSerialization.data(withJSONObject: ["records": records])
            }.value
            let result = try await api.importRecords(payload)
            await refreshList()
            setStatus("Imported \(result.imported) memories.")
        } catch {
            setStatus("Import failed: \(error.localizedDescription)", isError: true)
        }
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

    // MARK: - Setup

    func submitApiKey(_ key: String) async throws {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        let configured = try await api.setApiKey(key)
        guard configured else { throw APIError(status: -1, message: "Key was not accepted.", needsKey: false) }
        await syncConfigGate()
    }

    // MARK: - Config / settings helpers

    func refreshConfig() async {
        guard let api else { return }
        self.config = try? await api.config()
    }

    func refreshSettings() async {
        guard let api else { return }
        self.settings = try? await api.settings()
    }

    var backendLabel: String {
        guard let config else { return "Backend: loading…" }
        if config.mode == "remote" {
            return "Remote: \(config.activeRemote?.name ?? "remote")"
        }
        return config.needsKey ? "Local: needs API key" : "Local"
    }

    var backendIsRemote: Bool { config?.mode == "remote" }
    var backendNeedsAttention: Bool { !(config?.configured ?? false) }

    // MARK: - Settings actions

    func applyMode(_ mode: String, name: String? = nil) async throws {
        guard let api else { return }
        self.settings = try await api.setMode(mode, name: name)
        await syncConfigGate()
    }

    func saveRemote(name: String, url: String, token: String?) async throws {
        guard let api else { return }
        self.settings = try await api.saveRemote(name: name, url: url, token: token)
        await refreshConfig()
    }

    func removeRemote(_ name: String) async throws {
        guard let api else { return }
        self.settings = try await api.removeRemote(name)
        await syncConfigGate()
    }

    func testRemote(_ name: String) async throws -> RemoteTestResult {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        return try await api.testRemote(name)
    }

    func importLocalToRemote(_ name: String) async throws -> MigrationResult {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        let result = try await api.importLocalToRemote(name)
        if backendIsRemote, config?.activeRemote?.name == name {
            await loadMemories()
        }
        return result
    }

    func setStatus(_ text: String, isError: Bool = false) {
        statusText = text
        statusIsError = isError
    }

    private static func countLabel(_ count: Int) -> String {
        "\(count) \(count == 1 ? "memory" : "memories")"
    }
}

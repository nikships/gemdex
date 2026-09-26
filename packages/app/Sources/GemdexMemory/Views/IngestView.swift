import SwiftUI
import AppKit

/// Ingest coding-agent chat history as memories. Four-step flow:
/// pick sources → scan (buckets + list-price estimate) → run with live
/// progress → done summary. Digests are written by the local Claude Code CLI
/// behind the sidecar's `/ingest/*` routes; this view is a thin client over
/// the Activity Center's polled status.
@MainActor
struct IngestView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var isEmbedded: Bool = false

    private enum Step {
        case sources
        case scanned
        case running
        case done
    }

    @State private var step: Step = .sources
    @State private var sources: IngestSources?
    @State private var selectedPresets: Set<String> = []
    @State private var selectedCustom: Set<String> = []
    @State private var scan: IngestScanSummary?
    @State private var selectedModel = ""
    @State private var status: IngestStatus?
    @State private var busy = false
    @State private var error: String?

    /// Prefer the Activity Center's live poll so closing this panel never
    /// freezes the numbers shown when the user comes back.
    private var liveStatus: IngestStatus? { model.ingestStatus ?? status }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    content
                    if let error {
                        Text(error).font(.callout).foregroundStyle(Brand.terracotta)
                            .textSelection(.enabled)
                    }
                }
                .padding(20)
            }
            Divider()
            footer
        }
        .frame(width: isEmbedded ? nil : 620, height: isEmbedded ? nil : 600)
        .frame(maxWidth: isEmbedded ? 600 : .infinity)
        .background(isEmbedded ? nil : BrandBackdrop())
        .task { await loadSources() }
        // Re-enter the right step if the Activity Center is already tracking
        // a run (user navigated away and came back).
        .onChange(of: model.ingestStatus?.state) { _ in
            syncStepWithActivity()
        }
        .onChange(of: model.activities[.ingest]?.phase) { _ in
            syncStepWithActivity()
        }
    }

    // MARK: - Header / footer

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Ingest chat history", systemImage: "tray.and.arrow.down")
                    .font(.title3.bold())
                Text("Distill coding-agent sessions into memories — one digest per session, with a pointer back to the raw transcript.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                close()
            } label: {
                Image(systemName: "xmark")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 26, height: 26)
                    .glassSurfaceInteractive(cornerRadius: 999)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel("Close")
        }
        .padding(20)
    }

    @ViewBuilder
    private var footer: some View {
        HStack {
            Spacer()
            switch step {
            case .sources:
                Button("Scan New Sessions") { Task { await runScan() } }
                    .buttonStyle(BrandButtonStyle())
                    .disabled(busy || !hasSelection || !ingestReady)
            case .scanned:
                Button("Back") { step = .sources; scan = nil; error = nil }
                Button("Start Ingestion") { Task { await start() } }
                    .buttonStyle(BrandButtonStyle())
                    .disabled(busy || (scan?.pendingCount ?? 0) == 0 || !ingestReady)
            case .running:
                Text(model.activities[.ingest]?.phase == .cancelling
                     ? "Cancelling… already-saved digests are kept"
                     : "Runs in the background — safe to leave this panel")
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Cancel") { model.cancelActivity(.ingest) }
                    .disabled(busy || model.activities[.ingest]?.phase == .cancelling)
            case .done:
                Button("Ingest more") {
                    step = .sources
                    scan = nil
                    status = nil
                    error = nil
                }
                Button("Done") { close() }
                    .buttonStyle(BrandButtonStyle())
            }
        }
        .padding(16)
    }

    // MARK: - Step content

    @ViewBuilder
    private var content: some View {
        switch step {
        case .sources: sourcesStep
        case .scanned: scannedStep
        case .running: runningStep
        case .done: doneStep
        }
    }

    @ViewBuilder
    private var sourcesStep: some View {
        if let sources {
            VStack(alignment: .leading, spacing: 14) {
                if !ingestReady {
                    ClaudeCodeReadinessAlert(
                        blockedFeature: "Scanning and ingestion are disabled. Digests are written by your local Claude Code CLI."
                    )
                }
                Text("Session folders").font(.headline)
                ForEach(sources.presets) { preset in
                    folderRow(preset,
                              checked: selectedPresets.contains(preset.source),
                              toggle: { togglePreset(preset) },
                              removable: false,
                              enabled: ingestReady)
                }
                ForEach(sources.customFolders) { folder in
                    folderRow(folder,
                              checked: selectedCustom.contains(folder.path),
                              toggle: { toggleCustom(folder) },
                              removable: true,
                              enabled: ingestReady)
                }
                Button {
                    addFolder()
                } label: {
                    Label("Add Folder…", systemImage: "plus")
                }
                .disabled(busy || !ingestReady)
            }
        } else {
            ProgressView("Loading sources…")
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 40)
        }
    }

    private func folderRow(
        _ folder: IngestFolderSummary,
        checked: Bool,
        toggle: @escaping () -> Void,
        removable: Bool,
        enabled: Bool = true
    ) -> some View {
        HStack(spacing: 10) {
            Toggle(isOn: Binding(get: { checked }, set: { _ in toggle() })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(folderTitle(folder)).font(.body.weight(.medium))
                    Text(folder.path).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            .toggleStyle(.checkbox)
            .disabled(!folder.exists || !enabled)
            Spacer()
            Text(folder.exists ? "\(folder.sessionCount) sessions" : "not found")
                .font(.caption)
                .foregroundStyle(folder.exists ? Color.secondary : Brand.terracotta)
            if removable {
                Button {
                    Task { await removeFolder(folder.path) }
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(!enabled || busy)
                .accessibilityLabel("Remove folder")
            }
        }
        .padding(10)
        .glassSurface(cornerRadius: Metric.radiusCard)
    }

    private func folderTitle(_ folder: IngestFolderSummary) -> String {
        switch folder.source {
        case "claude": return "Claude Code"
        case "factory": return "Factory CLI"
        case "codex": return "Codex"
        case "antigravity": return "Antigravity"
        default: return (folder.path as NSString).lastPathComponent
        }
    }

    @ViewBuilder
    private var scannedStep: some View {
        if let scan {
            VStack(alignment: .leading, spacing: 16) {
                Text("Scan results").font(.headline)
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    GridRow {
                        Text("New sessions ready to ingest"); Text("\(scan.pendingCount)").bold()
                    }
                    GridRow {
                        Text("Previously ingested, later changed");
                        Text("\(scan.buckets.changedFiles.count) skipped").foregroundStyle(.secondary)
                    }
                    GridRow {
                        Text("Previously ingested, unchanged"); Text("\(scan.buckets.upToDate.count)").foregroundStyle(.secondary)
                    }
                    GridRow {
                        Text("Skipped (active in last 10 min)"); Text("\(scan.buckets.skippedActive.count)").foregroundStyle(.secondary)
                    }
                }
                .font(.callout)

                if !scan.buckets.changedFiles.isEmpty {
                    Label("Gemdex never reprocesses a session after its first successful ingest. Changed transcripts stay linked through the original memory's provenance path.",
                          systemImage: "lock.shield.fill")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(10)
                        .glassSurface(cornerRadius: Metric.radiusCard, tint: Brand.sage)
                }

                if scan.pendingCount == 0 {
                    Label("No new sessions to ingest. Previously ingested sessions are left untouched.",
                          systemImage: "checkmark.circle")
                        .foregroundStyle(Brand.sage)
                } else {
                    Divider()
                    Text("Model & cost").font(.headline)
                    Text("≈ \(formatTokens(scan.estimatedInputTokens)) input tokens across \(scan.pendingCount) new sessions. Pricing as of \(sources?.pricingAsOf ?? "—").")
                        .font(.caption).foregroundStyle(.secondary)
                    ClaudeModelCostSummary(
                        models: sources?.models ?? [],
                        estimates: scan.estimates,
                        selectedModel: $selectedModel
                    )
                }
            }
        }
    }

    private var runningStep: some View {
        let s = liveStatus
        return VStack(alignment: .leading, spacing: 14) {
            Text(model.activities[.ingest]?.phase == .cancelling ? "Cancelling…" : "Ingesting…")
                .font(.headline)
            let processed = (s?.processed ?? 0) + (s?.failed ?? 0)
            ProgressView(value: Double(processed), total: Double(max(s?.total ?? 1, 1)))
                .tint(Brand.gold)
            HStack {
                Text("\(s?.processed ?? 0) ingested · \(s?.failed ?? 0) failed · \(s?.total ?? 0) total")
                    .font(.callout).foregroundStyle(.secondary)
                Spacer()
            }
            if let current = s?.currentFile {
                Text(current).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Label("Progress stays visible in the activity bar if you leave this panel. Cancel keeps already-saved digests; re-run later to continue with remaining sessions.",
                  systemImage: "info.circle")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var doneStep: some View {
        let s = liveStatus
        let phase = model.activities[.ingest]?.phase
        let failed = s?.failed ?? 0
        let wasCancelled = phase == .cancelled || s?.state == "cancelled"
        let ingested = s?.processed ?? 0
        let headline: String = {
            if wasCancelled { return "Ingestion cancelled" }
            if failed == 0 { return "Ingestion complete" }
            return "Ingestion finished with failures"
        }()
        let icon: String = {
            if wasCancelled { return "xmark.circle" }
            if failed == 0 { return "checkmark.circle" }
            return "exclamationmark.triangle"
        }()
        let color: Color = {
            if wasCancelled { return Color.secondary }
            if failed == 0 { return Brand.sage }
            return Brand.terracotta
        }()
        return VStack(alignment: .leading, spacing: 14) {
            Label(headline, systemImage: icon)
                .font(.headline)
                .foregroundStyle(color)
            Text("\(ingested) memories saved" + (failed > 0 ? " · \(failed) sessions failed" : ""))
                .font(.callout)
            if wasCancelled {
                Text("Already-saved digests stay in your store. Scan again to continue with sessions that were not yet processed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let err = s?.error {
                Text(err).font(.caption).foregroundStyle(Brand.terracotta).textSelection(.enabled)
            }
            Text("Each memory ends with a provenance line pointing at the raw transcript on disk, so agents can recall the digest and open the full session when needed.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: - Selection helpers

    private var hasSelection: Bool { !selectedPresets.isEmpty || !selectedCustom.isEmpty }

    /// Read from `AppModel` rather than `sources.ingestReady` so "Check again"
    /// unlocks the panel without reloading sources.
    private var ingestReady: Bool { model.ingestionIsReady }

    private var selectedSourcePayload: [[String: Any]] {
        var payload: [[String: Any]] = selectedPresets.sorted().map { ["source": $0] }
        payload += selectedCustom.sorted().map { ["source": "custom", "path": $0] }
        return payload
    }

    private func togglePreset(_ preset: IngestFolderSummary) {
        if selectedPresets.contains(preset.source) {
            selectedPresets.remove(preset.source)
        } else {
            selectedPresets.insert(preset.source)
        }
    }

    private func toggleCustom(_ folder: IngestFolderSummary) {
        if selectedCustom.contains(folder.path) {
            selectedCustom.remove(folder.path)
        } else {
            selectedCustom.insert(folder.path)
        }
    }

    // MARK: - Actions

    private func close() {
        if isEmbedded {
            model.showIngest = false
        } else {
            dismiss()
        }
    }

    private func loadSources() async {
        guard let api = model.api else { return }
        do {
            let loaded = try await api.ingestSources()
            apply(sources: loaded)
            // Preselect presets that exist and have sessions.
            for preset in loaded.presets where preset.exists && preset.sessionCount > 0 {
                selectedPresets.insert(preset.source)
            }
            await model.refreshActivityStatus()
            // Resume whatever the Activity Center / sidecar already knows.
            resumeFromActivity()
        } catch {
            if model.handleNeedsInstall(error) { return }
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Jump to running / done when reopening mid-flight. Returns true
    /// when the panel was rehydrated from live activity (so callers skip the
    /// default sources layout).
    @discardableResult
    private func resumeFromActivity() -> Bool {
        if let latest = model.ingestStatus {
            status = latest
        }
        return syncStepWithActivity()
    }

    @discardableResult
    private func syncStepWithActivity() -> Bool {
        let state = model.ingestStatus?.state
            ?? model.activities[.ingest].map { activityState($0.phase) }
        switch state {
        case "running":
            if step != .running { step = .running }
            status = model.ingestStatus ?? status
            return true
        case "done", "failed", "cancelled":
            // Only jump to done if we were already on a run step (or the
            // activity chip is still visible) — don't override a fresh sources
            // visit after a long-finished prior run.
            if step == .running || model.activities[.ingest] != nil {
                if step != .done { step = .done }
                status = model.ingestStatus ?? status
                return true
            }
            return false
        default:
            return false
        }
    }

    private func activityState(_ phase: JobPhase) -> String {
        switch phase {
        case .running, .cancelling: return "running"
        case .completed: return "done"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        }
    }

    private func apply(sources loaded: IngestSources) {
        sources = loaded
        model.noteClaudeCode(loaded.claudeCode)
        if selectedModel.isEmpty {
            selectedModel = loaded.models.first(where: { $0.isDefault })?.model
                ?? loaded.models.first?.model ?? ""
        }
        // Drop selections for folders that no longer exist.
        let knownCustom = Set(loaded.customFolders.map(\.path))
        selectedCustom.formIntersection(knownCustom)
    }

    private func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder containing .jsonl session transcripts"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            await withBusy {
                let loaded = try await model.api?.addIngestFolder(url.path)
                if let loaded {
                    apply(sources: loaded)
                    selectedCustom.insert(url.path)
                }
            }
        }
    }

    private func removeFolder(_ path: String) async {
        await withBusy {
            if let loaded = try await model.api?.removeIngestFolder(path) {
                apply(sources: loaded)
            }
        }
    }

    private func runScan() async {
        await withBusy {
            guard let api = model.api else { return }
            scan = try await api.ingestScan(sources: selectedSourcePayload)
            step = .scanned
        }
    }

    private func start() async {
        await withBusy {
            guard let api = model.api else { return }
            try await api.ingestStart(sources: selectedSourcePayload, model: selectedModel)
            status = nil
            // Hand ownership to the Activity Center so leaving the panel is safe.
            model.noteIngestStarted(total: scan?.pendingCount ?? 0)
            step = .running
        }
    }

    private func withBusy(_ work: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await work()
        } catch {
            if model.handleNeedsInstall(error) { return }
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: - Formatting

    private func formatTokens(_ tokens: Int) -> String {
        if tokens >= 1_000_000 { return String(format: "%.1fM", Double(tokens) / 1_000_000) }
        if tokens >= 1_000 { return String(format: "%.0fk", Double(tokens) / 1_000) }
        return "\(tokens)"
    }
}

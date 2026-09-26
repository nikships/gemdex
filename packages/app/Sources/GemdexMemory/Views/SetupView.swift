import SwiftUI

/// First-run screen shown while the local embedding model is not installed
/// (`config.configured == false`). Installing is an explicit, confirmed action;
/// progress stays visible here and in the Activity Center.
struct SetupView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header
                ActivityRail(hiding: .embedding)
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Install the local embedding model").font(.title3.bold())
                        Text("Gemdex embeds memories on this Mac with BGE-M3 running on MLX. Nothing leaves your machine, and no API key is needed. The download is about 600 MB and runs once.")
                            .font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    EmbeddingModelPanel(allowsMigration: false)
                    Label("Requires a Mac with Apple Silicon (M1 or later). MLX does not run on Intel Macs.",
                          systemImage: "cpu")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(22)
                .frame(maxWidth: 620, alignment: .leading)
                .glassSurface(cornerRadius: Metric.radiusPanel)
            }
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .background(BrandBackdrop())
        .task { await model.refreshEmbeddingStatus() }
    }

    private var header: some View {
        VStack(spacing: 12) {
            (Brand.image("logo-mark") ?? Image(systemName: "brain.head.profile"))
                .resizable().scaledToFit().frame(width: 92, height: 92)
                .shadow(color: Brand.gold.opacity(0.35), radius: 22, y: 8)
            if let wordmark = Brand.image("wordmark") {
                wordmark.resizable().scaledToFit().frame(maxWidth: 280)
            } else {
                Text("Gemdex Memory").font(.largeTitle.bold())
            }
            Text("Your memories live in ~/.gemdex on this Mac. Chat-history ingestion and memory hygiene run on your local Claude Code CLI.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)
        }
    }
}

/// Local embedding model status with install (and optionally migrate)
/// controls. Shared by the setup screen and the Storage & Models panel. Every
/// job needs explicit confirmation; progress is owned by `AppModel`.
struct EmbeddingModelPanel: View {
    @EnvironmentObject var model: AppModel
    let allowsMigration: Bool

    @State private var confirmInstall = false
    @State private var confirmMigration = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let state = model.embeddingStatus {
                HStack(spacing: 8) {
                    Image(systemName: statusIcon(state))
                        .foregroundStyle(statusColor(state))
                    Text(statusTitle(state)).font(.callout.bold())
                }
                Text(state.model).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if let message = state.message, !message.isEmpty {
                    Text(message).font(.callout)
                        .foregroundStyle(state.status == "error" ? Brand.terracotta : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if state.isRunning {
                    if let total = state.total, total > 0 {
                        ProgressView(value: Double(min(state.completed ?? 0, total)), total: Double(total))
                            .tint(Brand.sage)
                        Text("\(state.completed ?? 0) / \(total)").font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    Text("Keep Gemdex running until this finishes. Progress also shows in the activity bar.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    if !state.installed {
                        Button(state.status == "error" ? "Retry installation…" : "Install local model…") {
                            confirmInstall = true
                        }
                        .brandPrimary()
                        .disabled(model.embeddingIsBusy)
                    }
                    Button("Refresh status") { Task { await model.refreshEmbeddingStatus() } }
                        .disabled(model.embeddingRequestPending)
                    if model.embeddingRequestPending { ProgressView().controlSize(.small) }
                }
                if allowsMigration && model.legacyMemoryCount > 0 {
                    legacyNotice(count: model.legacyMemoryCount)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking the local embedding model…").font(.callout).foregroundStyle(.secondary)
                }
            }
            if let error = model.embeddingError {
                Text(error).font(.callout).foregroundStyle(Brand.terracotta).textSelection(.enabled)
            }
        }
        .alert("Install the local embedding model?", isPresented: $confirmInstall) {
            Button("Cancel", role: .cancel) {}
            Button("Download & install") { Task { await model.startEmbeddingJob(.install) } }
        } message: {
            Text("Downloads the MLX runtime and the BGE-M3 model (about 600 MB) to this Mac. Requires Apple Silicon. Keep Gemdex running until it finishes.")
        }
        .alert(migrateTitle, isPresented: $confirmMigration) {
            Button("Cancel", role: .cancel) {}
            Button("Migrate") { Task { await model.startEmbeddingJob(.migrate) } }
        } message: {
            Text("Re-embeds memories saved with the previous Gemini embedding model so they show up in search. This can take a while; keep Gemdex running.")
        }
    }

    private var migrateTitle: String {
        let n = model.legacyMemoryCount
        return "Migrate \(n) \(n == 1 ? "memory" : "memories") to the local model?"
    }

    private func legacyNotice(count: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("\(count) \(count == 1 ? "memory is" : "memories are") still in the old Gemini index and will not appear in search until re-embedded.",
                  systemImage: "arrow.triangle.2.circlepath")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Button("Migrate \(count) \(count == 1 ? "memory" : "memories")…") { confirmMigration = true }
                .brandPrimary()
                .disabled(model.embeddingIsBusy)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(cornerRadius: Metric.radiusCard, tint: Brand.gold)
    }

    private func statusTitle(_ state: EmbeddingStatus) -> String {
        switch state.status {
        case "installed": return "Installed"
        case "installing": return "Installing…"
        case "migrating": return "Migrating memories…"
        case "error": return "Needs attention"
        default: return "Not installed"
        }
    }

    private func statusIcon(_ state: EmbeddingStatus) -> String {
        switch state.status {
        case "installed": return "checkmark.seal.fill"
        case "installing", "migrating": return "arrow.down.circle"
        case "error": return "exclamationmark.triangle.fill"
        default: return "shippingbox"
        }
    }

    private func statusColor(_ state: EmbeddingStatus) -> Color {
        switch state.status {
        case "installed": return Brand.sage
        case "error": return Brand.terracotta
        default: return Brand.gold
        }
    }
}

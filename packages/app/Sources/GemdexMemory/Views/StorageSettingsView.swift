import SwiftUI

/// Storage & Models settings: appearance, the local embedding model (status,
/// install, migrate), and the Claude Code CLI used for ingestion and hygiene.
struct StorageSettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var isEmbedded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    appearanceSection
                    embeddingSection
                    claudeCodeSection
                }
                .padding(20)
            }
        }
        .frame(width: isEmbedded ? nil : 620)
        .frame(minHeight: isEmbedded ? 0 : 560)
        .frame(maxWidth: isEmbedded ? 640 : .infinity, maxHeight: isEmbedded ? .infinity : nil)
        .background(isEmbedded ? nil : BrandBackdrop())
        .task { await refresh() }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Storage & Models", systemImage: "externaldrive")
                    .font(.title3.bold())
                    .labelStyle(.titleAndIcon)
                Text("Memories are stored in ~/.gemdex on this Mac and embedded locally. Chat-history ingestion and hygiene run on your Claude Code CLI.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                if isEmbedded {
                    model.showSettings = false
                } else {
                    dismiss()
                }
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

    private var embeddingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Local embedding model").font(.headline)
            Text("BGE-M3 on MLX embeds memory text on this Mac (Apple Silicon only). Memories saved with the previous Gemini embedding model need a one-time, confirmed migration before they appear in search.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            EmbeddingModelPanel(allowsMigration: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassSurface(cornerRadius: Metric.radiusCard)
        }
    }

    private var claudeCodeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude Code").font(.headline)
            Text("Chat-history ingestion and memory hygiene call your local Claude Code CLI (`claude -p`, Haiku model) with your existing Claude login.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if model.ingestionIsReady && !model.claudeCodeIsChecking {
                claudeCodeReadyRow
            } else {
                ClaudeCodeReadinessAlert(
                    blockedFeature: "Ingestion and hygiene are disabled until Claude Code is ready.",
                    showsSettingsButton: false
                )
            }
            claudeCodeDetails
        }
    }

    private var claudeCodeReadyRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill").foregroundStyle(Brand.sage)
            VStack(alignment: .leading, spacing: 2) {
                Text(ClaudeCodeCopy.title(model.claudeCode, checking: false)).font(.callout.bold())
                Text(model.claudeCode?.message ?? ClaudeCodeCopy.fallbackDetail(model.claudeCode))
                    .font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            Button {
                Task { await model.checkClaudeCode() }
            } label: {
                HStack(spacing: 6) {
                    if model.claudeCodeCheckPending { ProgressView().controlSize(.small) }
                    Text("Check again")
                }
            }
            .disabled(model.claudeCodeIsChecking)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(cornerRadius: Metric.radiusCard, tint: Brand.sage)
    }

    @ViewBuilder
    private var claudeCodeDetails: some View {
        if let cc = model.claudeCode {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                GridRow {
                    Text("Status").foregroundStyle(.secondary)
                    Text(cc.status).font(.caption.monospaced())
                }
                if let version = cc.version {
                    GridRow {
                        Text("Version").foregroundStyle(.secondary)
                        Text(version).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
                if let path = cc.path {
                    GridRow {
                        Text("Path").foregroundStyle(.secondary)
                        Text(path).font(.caption.monospaced()).textSelection(.enabled)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                if let checkedAt = cc.checkedAt {
                    GridRow {
                        Text("Checked").foregroundStyle(.secondary)
                        Text(Date(timeIntervalSince1970: checkedAt / 1000).formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                    }
                }
            }
            .font(.caption)
        }
    }

    private var appearanceSection: some View {
        @AppStorage(Appearance.storageKey) var appearanceRaw = Appearance.system.rawValue
        return VStack(alignment: .leading, spacing: 10) {
            Text("Appearance").font(.headline)
            Picker("", selection: $appearanceRaw) {
                ForEach(Appearance.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text("OLED Pure Black renders the window and sidebar as true black so unlit pixels stay fully off.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func refresh() async {
        await model.refreshConfig()
        await model.refreshEmbeddingStatus()
    }
}

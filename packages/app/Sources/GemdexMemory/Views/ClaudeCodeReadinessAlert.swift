import SwiftUI

/// Inline alert shown when the local Claude Code CLI cannot run chat-history
/// ingestion or hygiene judging. Offers a re-probe and a jump to Settings.
struct ClaudeCodeReadinessAlert: View {
    @EnvironmentObject var model: AppModel
    /// Short line naming what is blocked, e.g. "Scanning and ingestion are disabled."
    let blockedFeature: String
    var showsSettingsButton = true

    var body: some View {
        let readiness = model.claudeCode
        let checking = model.claudeCodeIsChecking
        let color: Color = checking ? Brand.gold : Brand.terracotta
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: checking ? "hourglass.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(color)
                VStack(alignment: .leading, spacing: 4) {
                    Text(ClaudeCodeCopy.title(readiness, checking: checking)).font(.callout.bold())
                    Text(readiness?.message ?? ClaudeCodeCopy.fallbackDetail(readiness))
                        .font(.callout)
                        .foregroundStyle(.primary.opacity(0.82))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    Text(blockedFeature)
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            if let error = model.claudeCodeError {
                Text(error).font(.caption).foregroundStyle(Brand.terracotta).textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Button {
                    Task { await model.checkClaudeCode() }
                } label: {
                    HStack(spacing: 6) {
                        if checking { ProgressView().controlSize(.small) }
                        Text(checking ? "Checking…" : "Check again")
                    }
                }
                .brandPrimary()
                .disabled(checking)
                if showsSettingsButton {
                    Button("Open Settings") {
                        model.showIngest = false
                        model.showHygiene = false
                        model.isEditorOpen = false
                        model.showSettings = true
                    }
                    .brandSecondary()
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: Metric.radiusCard, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radiusCard, style: .continuous)
                .strokeBorder(color.opacity(0.8), lineWidth: 1.5)
        )
    }
}

/// Model label (or picker when the sidecar offers several) plus the
/// API-list-price estimate for an ingestion or hygiene run.
struct ClaudeModelCostSummary: View {
    let models: [IngestModelInfo]
    let estimates: [IngestCostEstimate]
    @Binding var selectedModel: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if models.count > 1 {
                Picker("Model", selection: $selectedModel) {
                    ForEach(models) { info in
                        Text("\(info.model) — \(info.description)").tag(info.model)
                    }
                }
            } else if let info = models.first {
                HStack(spacing: 6) {
                    Text("Model").foregroundStyle(.secondary)
                    Text(info.model).font(.callout.monospaced().bold())
                    Text("— \(info.description)").foregroundStyle(.secondary)
                }
                .font(.callout)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("≈ \(formatUsd(selectedEstimate?.usd ?? 0)) at API list price")
                    .font(.callout.monospacedDigit().bold())
                Text("Signed in to Claude Code with a Claude subscription? This run is covered by your plan and is not billed per token.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSurface(cornerRadius: Metric.radiusCard)
        }
    }

    private var selectedEstimate: IngestCostEstimate? {
        estimates.first { $0.model == selectedModel } ?? estimates.first
    }

    private func formatUsd(_ value: Double) -> String {
        value < 0.01 && value > 0 ? "<$0.01" : String(format: "$%.2f", value)
    }
}

/// User-facing copy for each Claude Code readiness status.
enum ClaudeCodeCopy {
    static func title(_ readiness: ClaudeCodeReadiness?, checking: Bool) -> String {
        if checking { return "Checking Claude Code…" }
        switch readiness?.status {
        case "ready": return "Claude Code is ready"
        case "missing": return "Claude Code is not installed"
        case "unauthenticated": return "Claude Code is not signed in"
        case "error": return "Claude Code check failed"
        default: return "Claude Code status unknown"
        }
    }

    static func fallbackDetail(_ readiness: ClaudeCodeReadiness?) -> String {
        switch readiness?.status {
        case "ready":
            return "Ingestion and hygiene run with `claude -p` on the Haiku model."
        case "missing":
            return "Install Claude Code from https://docs.claude.com/en/docs/claude-code, or set GEMDEX_CLAUDE_PATH to the claude binary, then check again."
        case "unauthenticated":
            return "Run `claude` in a terminal and use /login (or run `claude auth login`), then check again."
        case "checking":
            return "Looking for the claude CLI and its login."
        default:
            return "Gemdex could not confirm that the claude CLI works. Check again, or open Settings for details."
        }
    }
}

import SwiftUI

/// Blocking first-run and recovery screen. Local mode never reaches the manager
/// until the sidecar proves the configured key with a real Gemini embedding call.
struct SetupView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header
                GeminiReadinessAlert(
                    readiness: model.geminiReadiness,
                    detail: model.setupNotice
                )

                HStack(alignment: .top, spacing: 18) {
                    localCard
                    remoteCard
                }
                .frame(maxWidth: 780)
            }
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .background(BrandBackdrop())
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
            Text("Gemdex is paused until its embedding connection is verified. This prevents saves, searches, imports, and session ingestions from failing later without a clear explanation.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 650)
        }
    }

    private var localCard: some View {
        SetupCard(
            title: "Use this Mac",
            subtitle: "Validate Gemini, then store memories locally with LanceDB. The key is written only after Gemini accepts it."
        ) {
            GeminiKeySetupPanel(primaryButtonTitle: "Validate & unlock Gemdex")
        }
    }

    private var remoteCard: some View {
        SetupCard(
            title: "Use a Gemdex Server",
            subtitle: "Connect to a server that owns memory embeddings. A validated local Gemini key is still required later for chat-history digestion."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Button("Configure remote storage") { model.showSettings = true }
                    .brandPrimary()
                    .frame(maxWidth: .infinity)
                Text("Remote storage can unlock the memory manager without putting an embedding key on this Mac. Ingestion remains visibly blocked until a local Gemini key is verified.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .sheet(isPresented: $model.showSettings) {
            StorageSettingsView().environmentObject(model)
        }
    }
}

/// High-contrast readiness alert shared by the blocking setup screen and the
/// ready-state manager shell. Red is intentional: this state prevents work.
struct GeminiReadinessAlert: View {
    let readiness: GeminiReadiness?
    var detail: String?
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(compact ? .title3 : .title2)
                .foregroundStyle(alertColor)
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(compact ? .callout.bold() : .title3.bold())
                Text(detail ?? readiness?.message ?? fallbackDetail)
                    .font(.callout)
                    .foregroundStyle(.primary.opacity(0.82))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(compact ? 12 : 18)
        .frame(maxWidth: compact ? .infinity : 780, alignment: .leading)
        .background(alertColor.opacity(0.14), in: RoundedRectangle(cornerRadius: Metric.radiusCard, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radiusCard, style: .continuous)
                .strokeBorder(alertColor.opacity(0.9), lineWidth: compact ? 1.5 : 2)
        )
        .accessibilityElement(children: .combine)
    }

    private var status: String { readiness?.status ?? "missing" }
    private var alertColor: Color { .red }
    private var icon: String { status == "checking" ? "hourglass.circle.fill" : "exclamationmark.octagon.fill" }

    private var title: String {
        switch status {
        case "checking": return "Validating your Gemini API key"
        case "invalid": return "Gemini rejected your API key"
        case "unavailable": return "Gemini validation could not complete"
        default: return "Gemini API key required"
        }
    }

    private var fallbackDetail: String {
        switch status {
        case "checking": return "Gemdex will unlock automatically after the validation request succeeds."
        case "invalid": return "Enter a working key below. Nothing will be persisted until Gemini accepts it."
        case "unavailable": return "Check your connection and retry, or enter a different key. Gemdex stays locked until validation succeeds."
        default: return "Add a key below. Gemdex will test it before enabling any embedding or ingestion work."
        }
    }
}

/// Key entry and validation controls used by onboarding and Storage settings.
struct GeminiKeySetupPanel: View {
    @EnvironmentObject var model: AppModel
    let primaryButtonTitle: String

    @State private var apiKey = ""
    @State private var submitting = false
    @State private var retrying = false
    @State private var error: String?
    @FocusState private var keyFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SecureField("GEMINI_API_KEY", text: $apiKey)
                .textFieldStyle(.roundedBorder)
                .focused($keyFocused)
                .onSubmit(submit)

            Button(action: submit) {
                HStack {
                    if submitting { ProgressView().controlSize(.small) }
                    Text(submitting ? "Validating with Gemini…" : primaryButtonTitle)
                }
                .frame(maxWidth: .infinity)
            }
            .brandPrimary()
            .disabled(submitting || retrying || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if canRetrySavedKey {
                Button {
                    Task { await retrySavedKey() }
                } label: {
                    HStack {
                        if retrying { ProgressView().controlSize(.small) }
                        Text(retrying ? "Retrying validation…" : "Retry saved key")
                    }
                }
                .disabled(submitting || retrying)
            }

            if let error {
                Label(error, systemImage: "xmark.octagon.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }

            Text("Your key is validated with a small embedding request, then stored locally in ~/.gemdex/.env. Gemdex never displays it again.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onAppear { keyFocused = true }
    }

    private var canRetrySavedKey: Bool {
        guard let status = model.geminiReadiness?.status else { return false }
        return status == "invalid" || status == "unavailable"
    }

    private func submit() {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        submitting = true
        error = nil
        Task {
            defer { submitting = false }
            do {
                try await model.submitApiKey(key)
                apiKey = ""
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func retrySavedKey() async {
        retrying = true
        error = nil
        defer { retrying = false }
        do {
            try await model.retryApiKeyValidation()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A bordered card used on the setup screen.
struct SetupCard<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.title3.bold())
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
            content
        }
        .padding(22)
        .frame(maxWidth: .infinity, minHeight: 300, alignment: .top)
        .glassSurface(cornerRadius: Metric.radiusPanel)
    }
}

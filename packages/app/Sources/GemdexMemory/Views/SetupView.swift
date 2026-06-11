import SwiftUI

/// First-run storage choice: configure a local Gemini key, or connect a remote
/// Gemdex Server. Mirrors the web app's setup screen.
struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var apiKey = ""
    @State private var submitting = false
    @State private var error: String?
    @FocusState private var keyFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 26) {
                header

                if let notice = model.setupNotice {
                    Label(notice, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(Brand.terracotta)
                        .frame(maxWidth: 720, alignment: .leading)
                }

                HStack(alignment: .top, spacing: 18) {
                    localCard
                    remoteCard
                }
                .frame(maxWidth: 720)

                if let error {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(Brand.terracotta)
                        .frame(maxWidth: 720, alignment: .leading)
                }
            }
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .background(BrandBackdrop())
        .onAppear { keyFocused = true }
    }

    private var header: some View {
        VStack(spacing: 14) {
            (Brand.image("logo-mark") ?? Image(systemName: "brain.head.profile"))
                .resizable().scaledToFit().frame(width: 100, height: 100)
                .shadow(color: Brand.gold.opacity(0.35), radius: 22, y: 8)
            if let wordmark = Brand.image("wordmark") {
                wordmark.resizable().scaledToFit().frame(maxWidth: 280)
            } else {
                Text("Gemdex Memory").font(.largeTitle.bold())
            }
            Text("Choose where Gemdex should store and embed your memories. Use this Mac directly, or connect to a Gemdex Server you control.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
        }
    }

    private var localCard: some View {
        SetupCard(title: "Local", subtitle: "Use Gemini + LanceDB on this machine. Your Google AI API key is stored locally in ~/.gemdex/.env.") {
            VStack(alignment: .leading, spacing: 10) {
                SecureField("GEMINI_API_KEY", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .focused($keyFocused)
                    .onSubmit(submit)
                Button(action: submit) {
                    HStack {
                        if submitting { ProgressView().controlSize(.small) }
                        Text("Use local storage")
                    }
                    .frame(maxWidth: .infinity)
                }
                .brandPrimary()
                .disabled(submitting || apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private var remoteCard: some View {
        SetupCard(title: "Remote", subtitle: "Connect through your BYOI Gemdex Server and keep the embedding key on your server instead of this Mac.") {
            Button("Add remote server") { model.showSettings = true }
                .brandPrimary()
                .frame(maxWidth: .infinity)
        }
        .sheet(isPresented: $model.showSettings) {
            StorageSettingsView().environmentObject(model)
        }
    }

    private func submit() {
        let key = apiKey.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return }
        submitting = true
        error = nil
        Task {
            do {
                try await model.submitApiKey(key)
                apiKey = ""
            } catch {
                self.error = error.localizedDescription
            }
            submitting = false
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
        .frame(maxWidth: .infinity, minHeight: 220, alignment: .top)
        .glassSurface(cornerRadius: Metric.radiusPanel)
    }
}

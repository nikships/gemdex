import SwiftUI

/// Routes the window between the launch intro, onboarding/recovery states, and
/// the main manager UI based on `AppModel.screen`. The intro overlay sits on
/// top until dismissed, regardless of sidecar progress underneath.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @State private var showIntro = true

    var body: some View {
        ZStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if showIntro {
                LaunchOverlay { withAnimation(.easeInOut(duration: 0.4)) { showIntro = false } }
                    .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: screenKey)
    }

    /// A stable key so SwiftUI animates between distinct screens, not on every
    /// associated-value tweak.
    private var screenKey: String {
        switch model.screen {
        case .launching: return "launching"
        case .setup: return "setup"
        case .ready: return "ready"
        case .needsNode: return "needsNode"
        case .needsBootstrap: return "needsBootstrap"
        case .installing: return "installing"
        case .sidecarFailed: return "sidecarFailed"
        case .remoteUnavailable: return "remoteUnavailable"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.screen {
        case .launching:
            LoadingView(message: model.statusText)
        case .setup:
            SetupView()
        case .ready:
            MainView()
        case .needsNode:
            RecoveryView(kind: .needsNode)
        case let .needsBootstrap(installed, detail):
            RecoveryView(kind: .needsBootstrap(previouslyInstalled: installed, detail: detail))
        case let .installing(detail):
            RecoveryView(kind: .installing(detail: detail))
        case let .sidecarFailed(detail):
            RecoveryView(kind: .failed(detail: detail))
        case let .remoteUnavailable(detail):
            RecoveryView(kind: .remoteUnavailable(detail: detail))
        }
    }
}

/// Centered spinner used while the sidecar is coming up.
struct LoadingView: View {
    let message: String
    var body: some View {
        VStack(spacing: 18) {
            (Brand.image("logo-mark") ?? Image(systemName: "brain.head.profile"))
                .resizable().scaledToFit().frame(width: 84, height: 84)
                .opacity(0.9)
            ProgressView()
                .controlSize(.large)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VisualEffectBackground(material: .windowBackground).ignoresSafeArea())
    }
}

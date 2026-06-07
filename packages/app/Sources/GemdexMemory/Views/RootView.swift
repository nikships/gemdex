import SwiftUI

/// Routes the window between the launch intro, onboarding/recovery states, and
/// the main manager UI based on `AppModel.screen`. The intro overlay sits on
/// top until dismissed, regardless of sidecar progress underneath.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @State private var showIntro = true

    var body: some View {
        ZStack {
            // Content is only mounted after the intro dismisses. The toolbar
            // lives in the window chrome layer (above any ZStack/zIndex), so
            // hiding content is the only way to prevent it bleeding through
            // the intro overlay.
            if !showIntro {
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            if showIntro {
                LaunchOverlay { withAnimation(.easeInOut(duration: 0.4)) { showIntro = false } }
                    .zIndex(10)
            }
        }
        .animation(model.showSettings ? nil : .easeInOut(duration: 0.25), value: screenKey)
    }

    /// A stable key so SwiftUI animates between distinct screens, not on every
    /// associated-value tweak.
    private var screenKey: String {
        switch model.screen {
        case .launching: "launching"
        case .setup: "setup"
        case .ready: "ready"
        case .needsNode: "needsNode"
        case .needsBootstrap: "needsBootstrap"
        case .installing: "installing"
        case .sidecarFailed: "sidecarFailed"
        case .remoteUnavailable: "remoteUnavailable"
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

/// Centered spinner used while the sidecar is coming up. Floats a Liquid Glass
/// capsule over the ambient brand backdrop.
struct LoadingView: View {
    let message: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        ZStack {
            BrandBackdrop()

            VStack(spacing: 22) {
                (Brand.image("logo-mark") ?? Image(systemName: "brain.head.profile"))
                    .resizable().scaledToFit().frame(width: 96, height: 96)
                    .shadow(color: Brand.gold.opacity(0.35), radius: 24, y: 8)
                    .scaleEffect(reduceMotion ? 1.0 : (breathe ? 1.04 : 0.97))
                    .animation(reduceMotion ? nil : .easeInOut(duration: 2.4).repeatForever(autoreverses: true), value: breathe)

                VStack(spacing: 14) {
                    ProgressView()
                        .controlSize(.large)
                    Text(message)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 22)
                .glassSurface(cornerRadius: Metric.radiusPanel)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { if !reduceMotion { breathe = true } }
    }
}

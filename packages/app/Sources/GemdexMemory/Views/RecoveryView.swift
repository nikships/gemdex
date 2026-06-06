import SwiftUI

/// Onboarding / recovery surface for the non-ready sidecar phases. Mirrors the
/// web app's recovery panel: install-and-start, retry, switch-to-local, or open
/// settings, depending on the phase.
struct RecoveryView: View {
    @EnvironmentObject var model: AppModel

    enum Kind: Equatable {
        case needsNode
        case needsBootstrap(previouslyInstalled: Bool, detail: String)
        case installing(detail: String)
        case failed(detail: String)
        case remoteUnavailable(detail: String)
    }

    let kind: Kind

    var body: some View {
        ZStack {
            BrandBackdrop()

            VStack(spacing: 18) {
                Image(systemName: iconName)
                    .font(.system(size: 38, weight: .light))
                    .foregroundStyle(Brand.gold)
                    .frame(width: 84, height: 84)
                    .glassSurface(cornerRadius: 999, tint: Brand.gold)
                Text(title)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 460)

                if case let .installing(detail) = kind {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(detail.isEmpty ? "Working…" : detail).foregroundStyle(.secondary)
                    }
                    .padding(.top, 4)
                }

                HStack(spacing: 12) {
                    ForEach(actions, id: \.label) { action in
                        Button(action.label, action: action.run)
                            .modifier(ActionStyle(prominent: action.prominent))
                    }
                }
                .padding(.top, 6)
            }
            .padding(44)
            .glassSurface(cornerRadius: Metric.radiusPanel)
            .frame(maxWidth: 520)
            .padding(40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var iconName: String {
        switch kind {
        case .needsNode: return "shippingbox"
        case .needsBootstrap: return "arrow.down.circle"
        case .installing: return "gearshape.2"
        case .failed: return "exclamationmark.triangle"
        case .remoteUnavailable: return "wifi.exclamationmark"
        }
    }

    private var title: String {
        switch kind {
        case .needsNode: return "Node.js is required"
        case let .needsBootstrap(installed, _): return installed ? "Reconnect the memory store" : "Finish setting up Gemdex"
        case .installing: return "Setting up Gemdex"
        case .failed: return "Setup didn’t finish"
        case .remoteUnavailable: return "Remote storage is unreachable"
        }
    }

    private var message: String {
        switch kind {
        case .needsNode:
            return "Gemdex needs Node.js (node + npx) on your PATH. Install Node 20+ from nodejs.org, then retry."
        case let .needsBootstrap(_, detail):
            return detail
        case .installing:
            return ""
        case let .failed(detail):
            return detail
        case let .remoteUnavailable(detail):
            return "\(detail) Open Storage settings to test or edit the remote, or switch to local storage if it is configured."
        }
    }

    private struct Action { let label: String; let prominent: Bool; let run: () -> Void }

    private var actions: [Action] {
        switch kind {
        case .needsNode:
            return [Action(label: "Retry", prominent: true) { model.sidecar.retry() }]
        case .needsBootstrap:
            return [
                Action(label: "Install & start", prominent: true) { model.sidecar.bootstrap(install: true) },
                Action(label: "Open Storage settings", prominent: false) { model.showSettings = true },
            ]
        case .installing:
            return []
        case .failed:
            return [
                Action(label: "Try again", prominent: true) { model.sidecar.bootstrap(install: true) },
                Action(label: "Retry connection", prominent: false) { model.sidecar.retry() },
            ]
        case .remoteUnavailable:
            return [
                Action(label: "Open Storage settings", prominent: true) { model.showSettings = true },
                Action(label: "Use local storage", prominent: false) { Task { try? await model.applyMode("local") } },
            ]
        }
    }

    private struct ActionStyle: ViewModifier {
        let prominent: Bool
        func body(content: Content) -> some View {
            if prominent { content.brandPrimary() } else { content.brandSecondary() }
        }
    }
}

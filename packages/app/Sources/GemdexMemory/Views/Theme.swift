import SwiftUI
import AppKit

/// Gemdex brand palette + shared style tokens. Colors are warm paper/terracotta
/// to match the hand-drawn brand art; surfaces fall back to semantic system
/// colors so dark mode and accessibility settings are respected.
enum Brand {
    static let gold = Color(red: 0.80, green: 0.58, blue: 0.24)
    static let terracotta = Color(red: 0.78, green: 0.42, blue: 0.31)
    static let sage = Color(red: 0.46, green: 0.55, blue: 0.45)
    static let ink = Color(red: 0.20, green: 0.17, blue: 0.13)

    /// Load a bundled brand image (PNG) from Resources/brand by name.
    static func image(_ name: String) -> Image? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "brand")
            ?? Bundle.main.url(forResource: name, withExtension: "png"),
              let nsImage = NSImage(contentsOf: url) else {
            return nil
        }
        return Image(nsImage: nsImage)
    }
}

/// A prominent brand-tinted button used for primary actions.
struct BrandButtonStyle: ButtonStyle {
    var prominent = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(prominent ? Brand.gold.opacity(configuration.isPressed ? 0.75 : 1) : Color(nsColor: .controlColor))
            )
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(prominent ? Color.clear : Color(nsColor: .separatorColor))
            )
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.9 : 1)
    }
}

extension View {
    func brandPrimary() -> some View { buttonStyle(BrandButtonStyle(prominent: true)) }
    func brandSecondary() -> some View { buttonStyle(BrandButtonStyle(prominent: false)) }
}

/// AppKit visual-effect material, respecting Reduce Transparency.
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .sidebar
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blending
    }
}

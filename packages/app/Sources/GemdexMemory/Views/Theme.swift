import SwiftUI
import AppKit

/// Gemdex brand palette + the shared Liquid Glass design system. Colors are
/// warm paper/terracotta to match the hand-drawn brand art; surfaces lean on
/// macOS 26 Liquid Glass (`.glassEffect`) where available and degrade to
/// vibrancy materials on macOS 13–15 so the app stays beautiful everywhere.
enum Brand {
    static let gold = Color(red: 0.83, green: 0.60, blue: 0.24)
    static let goldBright = Color(red: 0.94, green: 0.72, blue: 0.33)
    static let terracotta = Color(red: 0.82, green: 0.43, blue: 0.31)
    static let sage = Color(red: 0.46, green: 0.57, blue: 0.46)
    static let ink = Color(red: 0.18, green: 0.15, blue: 0.12)

    /// Warm accent gradient used on prominent controls and highlights.
    static let warmGradient = LinearGradient(
        colors: [goldBright, gold, terracotta],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

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

/// Design tokens — an 8pt-grid spacing scale and the macOS corner-radius ladder.
enum Metric {
    static let radiusWindow: CGFloat = 16
    static let radiusPanel: CGFloat = 18
    static let radiusCard: CGFloat = 13
    static let radiusControl: CGFloat = 10
    static let radiusChip: CGFloat = 8
}

// MARK: - Liquid Glass helpers

extension View {
    /// A floating glass surface (cards, panels). Uses real Liquid Glass on
    /// macOS 26+, and a tasteful vibrancy + hairline fallback below that.
    ///
    /// The Liquid Glass APIs only exist in the macOS 26 SDK (Swift 6.2+
    /// toolchain), so the `#if compiler(>=6.2)` guard keeps older SDKs (e.g.
    /// CI's Swift 5.10 / macOS 14) compiling the fallback — `#available` alone
    /// is a runtime gate and can't hide a symbol that's missing at compile time.
    @ViewBuilder
    func glassSurface(cornerRadius: CGFloat = Metric.radiusCard, tint: Color? = nil) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            if let tint {
                glassEffect(.regular.tint(tint.opacity(0.18)), in: .rect(cornerRadius: cornerRadius))
            } else {
                glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
            }
        } else {
            glassFallback(cornerRadius: cornerRadius, tint: tint)
        }
        #else
        glassFallback(cornerRadius: cornerRadius, tint: tint)
        #endif
    }

    /// Vibrancy + hairline-stroke fallback used on pre-macOS-26 SDKs/runtimes.
    /// The tint fill lives *inside* the background so it sits behind content
    /// (keeping text/icon contrast); only the hairline stroke overlays on top.
    @ViewBuilder
    func glassFallback(cornerRadius: CGFloat, tint: Color?) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(tint?.opacity(0.10) ?? .clear)
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.35), Color.white.opacity(0.05)],
                        startPoint: .top, endPoint: .bottom
                    ),
                    lineWidth: 0.75
                )
        )
    }

    /// An interactive glass surface that reacts to hover/press on macOS 26+.
    @ViewBuilder
    func glassSurfaceInteractive(cornerRadius: CGFloat = Metric.radiusCard, tint: Color? = nil) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            if let tint {
                glassEffect(.regular.tint(tint.opacity(0.20)).interactive(), in: .rect(cornerRadius: cornerRadius))
            } else {
                glassEffect(.regular.interactive(), in: .rect(cornerRadius: cornerRadius))
            }
        } else {
            glassFallback(cornerRadius: cornerRadius, tint: tint)
        }
        #else
        glassFallback(cornerRadius: cornerRadius, tint: tint)
        #endif
    }

    /// macOS 26 progressive blur at scroll edges; no-op below.
    @ViewBuilder
    func softScrollEdges() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// A prominent, warm-gradient primary button with a Liquid Glass sheen.
struct BrandButtonStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        let label = configuration.label
            .font(.body.weight(.semibold))
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .contentShape(RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous))

        Group {
            if prominent {
                label
                    .foregroundStyle(.white)
                    .background(
                        RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous)
                            .fill(Brand.warmGradient)
                            .overlay(
                                RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.25), lineWidth: 0.75)
                            )
                            .shadow(color: Brand.gold.opacity(configuration.isPressed ? 0.10 : 0.30),
                                    radius: configuration.isPressed ? 3 : 9, y: configuration.isPressed ? 1 : 4)
                    )
            } else {
                label
                    .foregroundStyle(.primary)
                    .glassSurfaceInteractive(cornerRadius: Metric.radiusControl)
            }
        }
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .opacity(configuration.isPressed ? 0.92 : 1)
        .animation(.spring(response: 0.28, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension View {
    func brandPrimary() -> some View { buttonStyle(BrandButtonStyle(prominent: true)) }
    func brandSecondary() -> some View { buttonStyle(BrandButtonStyle(prominent: false)) }
}

/// An ambient, slowly-drifting brand-tinted backdrop that sits behind the
/// window's vibrancy. Gives the Liquid Glass surfaces something warm and alive
/// to refract. Respects Reduce Motion (drift disabled) and stays subtle so
/// content keeps its contrast.
struct BrandBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        ZStack {
            VisualEffectBackground(material: .underWindowBackground).ignoresSafeArea()

            GeometryReader { geo in
                let w = geo.size.width
                let h = geo.size.height
                ZStack {
                    blob(Brand.gold, opacity: scheme == .dark ? 0.30 : 0.22, radius: w * 0.45)
                        .frame(width: w * 0.9, height: w * 0.9)
                        .offset(x: drift ? -w * 0.22 : -w * 0.30,
                                y: drift ? -h * 0.28 : -h * 0.20)
                    blob(Brand.terracotta, opacity: scheme == .dark ? 0.26 : 0.18, radius: w * 0.4)
                        .frame(width: w * 0.8, height: w * 0.8)
                        .offset(x: drift ? w * 0.32 : w * 0.24,
                                y: drift ? h * 0.10 : h * 0.22)
                    blob(Brand.sage, opacity: scheme == .dark ? 0.22 : 0.14, radius: w * 0.35)
                        .frame(width: w * 0.7, height: w * 0.7)
                        .offset(x: drift ? w * 0.05 : -w * 0.02,
                                y: drift ? h * 0.40 : h * 0.34)
                }
                .blur(radius: 80)
                .drawingGroup()
            }
            .ignoresSafeArea()
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 18).repeatForever(autoreverses: true)) {
                drift = true
            }
        }
    }

    private func blob(_ color: Color, opacity: Double, radius: CGFloat) -> some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [color.opacity(opacity), color.opacity(0)],
                    center: .center, startRadius: 0, endRadius: max(radius, 1)
                )
            )
    }
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

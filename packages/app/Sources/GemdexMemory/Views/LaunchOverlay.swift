import SwiftUI
import AVKit
import AVFoundation

/// Full-window startup intro. Plays the bundled `startup-intro.mp4` natively
/// (autoplay, muted), then dismisses on video end, click, the Skip button, or
/// any playback failure. If the asset is missing it falls back to an animated
/// brand reveal so launch never hangs on the overlay.
struct LaunchOverlay: View {
    let onDismiss: () -> Void

    @State private var player: AVPlayer?
    @State private var didFail = false
    @State private var endObserver: NSObjectProtocol?
    @State private var failObserver: NSObjectProtocol?
    @State private var appeared = false

    private var videoURL: URL? {
        Bundle.main.url(forResource: "startup-intro", withExtension: "mp4")
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player, !didFail {
                VideoLayerView(player: player)
                    .ignoresSafeArea()
            } else {
                BrandReveal()
            }

            // Skip affordance, bottom-trailing.
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Button(action: dismiss) {
                        Text("Skip")
                            .font(.callout.weight(.medium))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                            .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                    .padding(28)
                    .opacity(appeared ? 1 : 0)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
        .onAppear(perform: setup)
        .onDisappear(perform: teardown)
        .transition(.opacity)
    }

    private func setup() {
        withAnimation(.easeIn(duration: 0.6).delay(0.8)) { appeared = true }

        guard let videoURL else {
            didFail = true
            // No asset: show the brand reveal briefly, then continue.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { dismiss() }
            return
        }

        let item = AVPlayerItem(url: videoURL)
        let avPlayer = AVPlayer(playerItem: item)
        avPlayer.isMuted = true
        avPlayer.actionAtItemEnd = .pause
        self.player = avPlayer

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { _ in dismiss() }

        failObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
        ) { _ in
            didFail = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { dismiss() }
        }

        // Safety net: never let the overlay outlive the clip by much.
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { dismiss() }

        avPlayer.play()
    }

    private func teardown() {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        player?.pause()
    }

    private func dismiss() {
        teardown()
        onDismiss()
    }
}

/// A plain AVPlayerLayer host that fills the window (aspect-fill) without the
/// AVKit playback controls — we want a clean, controlless cinematic.
private struct VideoLayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> PlayerNSView {
        let view = PlayerNSView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateNSView(_ nsView: PlayerNSView, context: Context) {
        nsView.playerLayer.player = player
    }
}

final class PlayerNSView: NSView {
    let playerLayer = AVPlayerLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = CALayer()
        layer?.backgroundColor = NSColor.black.cgColor
        playerLayer.frame = bounds
        layer?.addSublayer(playerLayer)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    override func layout() {
        super.layout()
        playerLayer.frame = bounds
    }
}

/// Animated fallback used when the video asset can't be loaded/played.
private struct BrandReveal: View {
    @State private var show = false

    var body: some View {
        VStack(spacing: 22) {
            (Brand.image("logo-mark") ?? Image(systemName: "brain.head.profile"))
                .resizable()
                .scaledToFit()
                .frame(width: 132, height: 132)
                .scaleEffect(show ? 1 : 0.7)
                .opacity(show ? 1 : 0)
            (Brand.image("wordmark") ?? nil).map { img in
                img.resizable().scaledToFit().frame(maxWidth: 320)
                    .opacity(show ? 1 : 0)
            }
            Text("Remember once, recall everywhere.")
                .font(.headline)
                .foregroundStyle(.white.opacity(0.85))
                .opacity(show ? 1 : 0)
        }
        .onAppear { withAnimation(.spring(response: 0.9, dampingFraction: 0.7)) { show = true } }
    }
}

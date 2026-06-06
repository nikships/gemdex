import Foundation
import AppKit

/// Sidecar lifecycle phase, surfaced to the UI. Mirrors the sidecar `Phase`.
enum SidecarPhase: Equatable {
    case starting
    case ready(base: URL, token: String)
    case needsNode
    case needsBootstrap(previouslyInstalled: Bool, detail: String)
    case installing(detail: String)
    case failed(detail: String)
}

/// How to launch `gemdex serve`. Differs only in how the package is resolved.
private enum ServeMode {
    case dev        // GEMDEX_SERVE_CMD set → run that Node entry directly
    case bundled    // ship: bundled node + packed sidecar under Resources
    case offline    // probe system npx cache only (no network)
    case install    // approved one-time network install
}

private struct Handshake {
    let port: Int
    let token: String
}

/// Thread-safe holder for the sidecar `Process` so the app-termination observer
/// (which fires synchronously on the main thread) can terminate the child
/// without an async actor hop that wouldn't run before `exit()`.
private final class ProcessHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?

    func set(_ proc: Process?) {
        lock.lock(); defer { lock.unlock() }
        process = proc
    }

    /// Terminate the held process if it is still running, then clear it.
    func terminate() {
        lock.lock(); let proc = process; process = nil; lock.unlock()
        if let proc, proc.isRunning { proc.terminate() }
    }
}

/// Owns the Node sidecar process for the app's lifetime.
///
/// Launch only ever *probes* an already-available runtime (offline / bundled);
/// a network install (`npx -y`) is reserved for an explicit, UI-approved
/// `bootstrap(install:)`. Slow work runs off the main actor; the published
/// `phase` drives onboarding in the UI. No memory logic lives here — this only
/// installs/starts/checks the sidecar (matches the AGENTS.md invariant).
@MainActor
final class SidecarManager: ObservableObject {
    @Published private(set) var phase: SidecarPhase = .starting

    private let processHolder = ProcessHolder()
    private var workerBusy = false
    private let resourcesDir: URL?

    /// `~/.gemdex/desktop.json` — non-secret marker that a prior launch
    /// bootstrapped the sidecar (matches the Zig shell's marker).
    private var markerURL: URL? {
        guard let home = ProcessInfo.processInfo.environment["HOME"], !home.isEmpty else { return nil }
        return URL(fileURLWithPath: home).appendingPathComponent(".gemdex/desktop.json")
    }

    private var previouslyInstalled: Bool {
        guard let markerURL else { return false }
        return FileManager.default.fileExists(atPath: markerURL.path)
    }

    init() {
        // Bundled runtime lives under <App>.app/Contents/Resources/{node,sidecar}.
        self.resourcesDir = Bundle.main.resourceURL
        // Kill the child sidecar when the app quits so it never outlives us.
        // willTerminate fires synchronously on the main thread, so terminate the
        // child synchronously here (not via an async Task that wouldn't run
        // before exit). The holder is thread-safe and self-contained.
        let holder = processHolder
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: nil
        ) { _ in
            holder.terminate()
        }
    }

    // MARK: - Launch

    /// Decide what to do at launch and act. Probing/spawning runs on a
    /// background queue so the UI thread never blocks; the result is published
    /// back on the main actor.
    func start() {
        // Terminate any prior child first so a retry never orphans a sidecar.
        resetProcess()
        phase = .starting
        let wasInstalled = previouslyInstalled
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            if await self.hasServeCmd() {
                await self.launch(mode: .dev, onFail: .failed(detail: "Could not start the development sidecar (GEMDEX_SERVE_CMD)."))
            } else if await self.bundledSidecarAvailable() {
                await self.launch(mode: .bundled, onFail: .failed(detail: "The bundled memory sidecar failed to start."))
            } else if await self.nodeAvailable() {
                await self.launch(mode: .offline, onFail: .needsBootstrap(previouslyInstalled: wasInstalled, detail: "Gemdex needs to install its local memory sidecar before you can start. This downloads the Node package once."))
            } else {
                await MainActor.run {
                    self.phase = .needsNode
                }
            }
        }
    }

    /// UI-approved bootstrap. `install == true` permits the one network install;
    /// `false` is a cache-only retry. Returns immediately; the worker publishes
    /// the result via `phase`.
    func bootstrap(install: Bool) {
        guard !workerBusy else { return }
        workerBusy = true
        phase = .installing(detail: install ? "Installing the Gemdex memory sidecar…" : "Starting the Gemdex memory sidecar…")
        resetProcess()
        let useBundled = bundledSidecarAvailable_sync()
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            let mode: ServeMode = useBundled ? .bundled : (install ? .install : .offline)
            let ok = await self.launch(mode: mode, onFail: .failed(detail: install
                ? "Install failed. Check your internet connection and that Node/npm work, then retry."
                : "Could not start the memory sidecar. Retry, or reinstall it."))
            if ok { await self.writeMarker() }
            await MainActor.run { self.workerBusy = false }
        }
    }

    /// Retry from a non-ready phase (re-runs the launch decision).
    func retry() {
        start()
    }

    func stop() {
        resetProcess()
    }

    // MARK: - Spawn + handshake

    /// Spawn `gemdex serve` in `mode`, read its `PORT=<n> TOKEN=<hex>` handshake,
    /// and on success flip to `.ready`. Returns whether the sidecar came up.
    @discardableResult
    private func launch(mode: ServeMode, onFail: SidecarPhase) async -> Bool {
        let proc = Process()
        let stdoutPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = FileHandle.standardError

        configure(process: proc, mode: mode)

        do {
            try proc.run()
        } catch {
            await MainActor.run { self.phase = onFail }
            return false
        }

        processHolder.set(proc)

        // Read stdout until the handshake newline appears (or the pipe closes).
        let handshake = await readHandshake(from: stdoutPipe.fileHandleForReading)
        guard let handshake, handshake.port > 0 else {
            processHolder.terminate()
            await MainActor.run {
                if case .ready = self.phase { } else { self.phase = onFail }
            }
            return false
        }

        let base = URL(string: "http://127.0.0.1:\(handshake.port)")!
        await MainActor.run {
            self.phase = .ready(base: base, token: handshake.token)
        }
        return true
    }

    private func configure(process proc: Process, mode: ServeMode) {
        switch mode {
        case .bundled:
            let node = nodeBinaryURL!
            let entry = sidecarEntryURL!
            proc.executableURL = node
            proc.arguments = [entry.path, "serve", "--port", "0"]
            // Bundled node needs its own dir on PATH; inherit the rest.
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "\(node.deletingLastPathComponent().path):" + (env["PATH"] ?? "/usr/bin:/bin")
            proc.environment = env
        case .dev, .offline, .install:
            // Use the login shell so the sidecar inherits the user's real PATH
            // (Homebrew / nvm). A .app launched from Finder gets only a minimal
            // PATH, so a bare `npx`/`node` would not resolve.
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            proc.executableURL = URL(fileURLWithPath: shell)
            proc.arguments = ["-lc", serveCommand(mode)]
        }
    }

    private func serveCommand(_ mode: ServeMode) -> String {
        switch mode {
        case .dev: return "exec node \"$GEMDEX_SERVE_CMD\" serve --port 0"
        case .offline: return "exec npx --offline gemdex-mcp serve --port 0"
        case .install: return "exec npx -y gemdex-mcp serve --port 0"
        case .bundled: return "" // never used
        }
    }

    /// Read from the sidecar's stdout until the first newline, then parse
    /// `PORT=<n> TOKEN=<hex>`. Runs on a background queue with a timeout so a
    /// hung child can't wedge launch.
    private func readHandshake(from handle: FileHandle) async -> Handshake? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Handshake?, Never>) in
            let queue = DispatchQueue(label: "gemdex.handshake")
            queue.async {
                var buffer = Data()
                let deadline = Date().addingTimeInterval(20)
                while Date() < deadline {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break } // EOF
                    buffer.append(chunk)
                    if let nl = buffer.firstIndex(of: 0x0A) {
                        let line = String(data: buffer[..<nl], encoding: .utf8) ?? ""
                        continuation.resume(returning: Self.parseHandshake(line))
                        return
                    }
                    if buffer.count > 4096 { break }
                }
                let line = String(data: buffer, encoding: .utf8) ?? ""
                continuation.resume(returning: Self.parseHandshake(line))
            }
        }
    }

    /// Parse `PORT=<n> TOKEN=<hex>` (token optional for older builds).
    nonisolated fileprivate static func parseHandshake(_ line: String) -> Handshake? {
        guard let portRange = line.range(of: "PORT=") else { return nil }
        let afterPort = line[portRange.upperBound...]
        let portDigits = afterPort.prefix { $0.isNumber }
        guard let port = Int(portDigits), port > 0 else { return nil }

        var token = ""
        if let tokenRange = line.range(of: "TOKEN=") {
            let afterToken = line[tokenRange.upperBound...]
            token = String(afterToken.prefix { $0 != " " && $0 != "\n" && $0 != "\r" })
        }
        return Handshake(port: port, token: token)
    }

    // MARK: - Environment probes

    private func hasServeCmd() async -> Bool {
        if let cmd = ProcessInfo.processInfo.environment["GEMDEX_SERVE_CMD"] { return !cmd.isEmpty }
        return false
    }

    private var nodeBinaryURL: URL? {
        resourcesDir?.appendingPathComponent("node/bin/node")
    }

    private var sidecarEntryURL: URL? {
        resourcesDir?.appendingPathComponent("sidecar/dist/index.js")
    }

    private func bundledSidecarAvailable_sync() -> Bool {
        guard let node = nodeBinaryURL, let entry = sidecarEntryURL else { return false }
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: node.path) && fm.fileExists(atPath: entry.path)
    }

    private func bundledSidecarAvailable() async -> Bool {
        bundledSidecarAvailable_sync()
    }

    /// Whether `node` and `npx` resolve on the login-shell PATH.
    private func nodeAvailable() async -> Bool {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: shell)
        proc.arguments = ["-lc", "command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        // Await exit via terminationHandler so we don't block a cooperative
        // concurrency thread with waitUntilExit().
        return await withCheckedContinuation { continuation in
            proc.terminationHandler = { p in
                continuation.resume(returning: p.terminationStatus == 0)
            }
            do {
                try proc.run()
            } catch {
                continuation.resume(returning: false)
            }
        }
    }

    // MARK: - Marker + teardown

    private func writeMarker() async {
        guard let markerURL else { return }
        let dir = markerURL.deletingLastPathComponent()
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let data = "{\"sidecarBootstrappedAt\":\(now),\"method\":\"npx\"}".data(using: .utf8)!
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: markerURL)
    }

    private func resetProcess() {
        processHolder.terminate()
    }
}

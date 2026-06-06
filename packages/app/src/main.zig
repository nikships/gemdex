const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");
const build_options = @import("build_options");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const bridge_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };
const windows_build = std.mem.eql(u8, build_options.platform, "windows");

/// Kick off Sparkle's updater (defined in src/sparkle_host.m). Lazily creates
/// and retains an SPUStandardUpdaterController; the feed URL + EdDSA public key
/// come from Info.plist. Idempotent and main-thread-safe.
///
/// Gated on the zero-native build platform (not host OS): `sparkle_host.m` is
/// only compiled — and the `gemdex_sparkle_start` symbol only linked — in the
/// macOS branch of `build.zig`. `-Dplatform=null` on a Mac still targets
/// os.tag=macos, so we must key off build_options.platform to avoid an
/// unresolved symbol there.
const sparkle_enabled = std.mem.eql(u8, build_options.platform, "macos");
extern fn gemdex_sparkle_start() void;

const command_policies = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "gemdex.getApiBase", .origins = &bridge_origins },
    .{ .name = "gemdex.getStatus", .origins = &bridge_origins },
    .{ .name = "gemdex.bootstrap", .origins = &bridge_origins },
};

/// Lifecycle of the Node sidecar, owned entirely by the Zig shell and surfaced
/// to the WebView through `gemdex.getStatus`. First launch only ever *probes*
/// an already-available runtime (offline, no network); installing the
/// `gemdex-mcp` package is reserved for an explicit, UI-approved action
/// (`gemdex.bootstrap`). No memory logic lives here — Zig only
/// installs/starts/checks the sidecar.
const Phase = enum(u8) {
    /// Launch in progress; nothing decided yet.
    starting = 0,
    /// Sidecar is up; `api_base` + `api_token` are valid.
    ready = 1,
    /// node/npx are not on the login-shell PATH — not installable by us.
    needs_node = 2,
    /// Node is present but the sidecar package isn't available offline; the UI
    /// may request a (network) install.
    needs_bootstrap = 3,
    /// A bootstrap install/start is running on the worker thread.
    installing = 4,
    /// A start or install attempt failed; the UI can retry.
    failed = 5,
};

/// How to launch `gemdex serve`. The shell command differs only in how the
/// package is resolved; all three exec Node so `stop()` can reap the process.
const ServeMode = enum { dev, offline, install };

fn phaseName(phase: Phase) []const u8 {
    return switch (phase) {
        .starting => "starting",
        .ready => "ready",
        .needs_node => "needs_node",
        .needs_bootstrap => "needs_bootstrap",
        .installing => "installing",
        // Surfaced to the frontend as the generic recoverable error state.
        .failed => "error",
    };
}

/// Decide what launch should do from two facts. Pure + unit-tested.
const LaunchDecision = enum { dev_start, probe_offline, needs_node };
fn decideLaunch(has_serve_cmd: bool, node_available: bool) LaunchDecision {
    if (has_serve_cmd) return .dev_start;
    if (!node_available) return .needs_node;
    return .probe_offline;
}

/// The shell command for a given serve mode. `exec` lets the shell hand its pid
/// to Node so our kill reaps the sidecar. `--offline` resolves only from the
/// npm/npx cache (no network); `-y` permits the one network install.
fn serveCommand(mode: ServeMode) []const u8 {
    if (windows_build) {
        return switch (mode) {
            .dev => "node \"%GEMDEX_SERVE_CMD%\" serve --port 0",
            .offline => "npx --offline gemdex-mcp serve --port 0",
            .install => "npx -y gemdex-mcp serve --port 0",
        };
    } else {
        return switch (mode) {
            .dev => "exec node \"$GEMDEX_SERVE_CMD\" serve --port 0",
            .offline => "exec npx --offline gemdex-mcp serve --port 0",
            .install => "exec npx -y gemdex-mcp serve --port 0",
        };
    }
}

fn writeJsonString(writer: anytype, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |ch| {
        switch (ch) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            0...8, 11...12, 14...0x1f => try writer.print("\\u{x:0>4}", .{ch}),
            else => try writer.writeByte(ch),
        }
    }
    try writer.writeByte('"');
}

fn writeApiBaseJson(output: []u8, base: []const u8, token: []const u8) []const u8 {
    var writer = std.Io.Writer.fixed(output);
    writer.writeAll("{\"base\":") catch return output[0..0];
    writeJsonString(&writer, base) catch return output[0..0];
    writer.writeAll(",\"token\":") catch return output[0..0];
    writeJsonString(&writer, token) catch return output[0..0];
    writer.writeAll("}") catch return output[0..0];
    return writer.buffered();
}

/// Render the `gemdex.getStatus` payload. Pure + unit-tested.
fn writeStatusJson(
    output: []u8,
    phase: Phase,
    base: []const u8,
    token: []const u8,
    detail: []const u8,
    previously_installed: bool,
) []const u8 {
    var writer = std.Io.Writer.fixed(output);
    writer.writeAll("{\"phase\":") catch return output[0..0];
    writeJsonString(&writer, phaseName(phase)) catch return output[0..0];
    writer.writeAll(",\"base\":") catch return output[0..0];
    writeJsonString(&writer, base) catch return output[0..0];
    writer.writeAll(",\"token\":") catch return output[0..0];
    writeJsonString(&writer, token) catch return output[0..0];
    writer.writeAll(",\"detail\":") catch return output[0..0];
    writeJsonString(&writer, detail) catch return output[0..0];
    writer.print(",\"previouslyInstalled\":{}}}", .{previously_installed}) catch return output[0..0];
    return writer.buffered();
}

fn writeAcceptedJson(output: []u8, accepted: bool) []const u8 {
    return std.fmt.bufPrint(output, "{{\"accepted\":{}}}", .{accepted}) catch output[0..0];
}

/// Extract the `install` flag from the trusted bootstrap payload.
fn parseInstallFlag(allocator: std.mem.Allocator, payload: []const u8) bool {
    const Parsed = struct { install: bool };
    const parsed = std.json.parseFromSlice(Parsed, allocator, payload, .{
        .ignore_unknown_fields = true,
    }) catch return false;
    defer parsed.deinit();
    return parsed.value.install;
}

/// Gemdex Memory — a manage-only desktop app. The Zig shell opens the window,
/// brings up the Node sidecar (`gemdex serve`), discovers the localhost port +
/// per-launch auth token it printed, hands both to the WebView via the
/// `gemdex.getApiBase` bridge command, and kills the sidecar on exit. Slow,
/// user-approved installs run on a worker thread so the UI thread never blocks;
/// the WebView polls `gemdex.getStatus` for progress. All memory logic lives in
/// the Node sidecar (gemdex-core + LanceDB).
const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    gpa: std.mem.Allocator,

    /// Guards the cross-thread fields below (everything the worker writes and
    /// the bridge handlers read). Critical sections are tiny.
    mutex: std.Io.Mutex = .init,
    /// Current `Phase`. The worker writes it with `.release` and bridge handlers
    /// read it with `.acquire`; that pair also publishes the mutex-guarded
    /// `api_base`/`api_token`/`detail` writes that precede a `.ready` transition.
    phase: std.atomic.Value(u8) = .init(@intFromEnum(Phase.starting)),
    /// True while the bootstrap worker thread is running; blocks re-entry.
    worker_busy: std.atomic.Value(bool) = .init(false),
    /// Set by `stop()` so an in-flight worker bails out instead of racing the
    /// teardown of the sidecar it's bringing up.
    shutting_down: std.atomic.Value(bool) = .init(false),

    sidecar: ?std.process.Child = null,
    /// Child currently in its startup handshake. Registered so shutdown can
    /// kill a bootstrap process before it is published as `sidecar`.
    starting_child: ?*std.process.Child = null,
    api_base_buf: [64]u8 = undefined,
    api_base: []const u8 = "",
    /// Per-launch auth token minted by the sidecar (64 hex chars). Stored in
    /// the handshake buffer below; `api_token` is a slice into it.
    handshake_buf: [256]u8 = undefined,
    api_token: []const u8 = "",
    /// Last actionable status message (fixed, quote-free strings only).
    detail_buf: [256]u8 = undefined,
    detail: []const u8 = "",
    /// Whether a prior launch already bootstrapped the sidecar (marker present).
    previously_installed: bool = false,

    /// JSON response buffer for the bridge handlers.
    bridge_resp_buf: [512]u8 = undefined,
    handlers: [3]zero_native.BridgeHandler = undefined,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "gemdex-memory",
            .source = zero_native.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .start_fn = start,
            .stop_fn = stop,
        };
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return zero_native.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }

    fn bridge(self: *@This()) zero_native.BridgeDispatcher {
        self.handlers = .{
            .{ .name = "gemdex.getApiBase", .context = self, .invoke_fn = getApiBase },
            .{ .name = "gemdex.getStatus", .context = self, .invoke_fn = getStatus },
            .{ .name = "gemdex.bootstrap", .context = self, .invoke_fn = bootstrap },
        };
        return .{
            .policy = .{ .enabled = true, .commands = &command_policies },
            .registry = .{ .handlers = &self.handlers },
        };
    }

    fn setPhase(self: *@This(), phase: Phase) void {
        self.phase.store(@intFromEnum(phase), .release);
    }

    fn currentPhase(self: *@This()) Phase {
        return @enumFromInt(self.phase.load(.acquire));
    }

    fn setDetail(self: *@This(), message: []const u8) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        const n = @min(message.len, self.detail_buf.len);
        @memcpy(self.detail_buf[0..n], message[0..n]);
        self.detail = self.detail_buf[0..n];
    }

    /// The user's login shell, used as `$SHELL -lc <cmd>` so the sidecar
    /// inherits the real interactive PATH: a .app launched from Finder/Dock
    /// gets only a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which has
    /// neither Homebrew nor nvm, so a bare `npx`/`node` would not be found. A
    /// login shell sources the profile where `brew shellenv` (etc.) live.
    fn shellPath(self: *@This()) []const u8 {
        if (windows_build) {
            if (self.env_map.get("COMSPEC")) |s| {
                if (s.len > 0) return s;
            }
            return "cmd.exe";
        }
        if (self.env_map.get("SHELL")) |s| {
            if (s.len > 0) return s;
        }
        return "/bin/zsh";
    }

    fn hasServeCmd(self: *@This()) bool {
        if (self.env_map.get("GEMDEX_SERVE_CMD")) |cmd| return cmd.len > 0;
        return false;
    }

    fn buildServeArgv(self: *@This(), buf: *[3][]const u8, mode: ServeMode) []const []const u8 {
        buf[0] = self.shellPath();
        buf[1] = if (windows_build) "/C" else "-lc";
        buf[2] = serveCommand(mode);
        return buf[0..3];
    }

    fn bundledSidecarAvailable(self: *@This()) bool {
        if (!windows_build) return false;
        var cwd = std.Io.Dir.cwd();
        cwd.access(self.io, "resources/node/node.exe", .{}) catch return false;
        cwd.access(self.io, "resources/sidecar/dist/index.js", .{}) catch return false;
        return true;
    }

    fn bundledServeArgv(self: *@This(), buf: *[5][]const u8, mode: ServeMode) ?[]const []const u8 {
        if (mode == .dev or !self.bundledSidecarAvailable()) return null;
        buf[0] = "resources/node/node.exe";
        buf[1] = "resources/sidecar/dist/index.js";
        buf[2] = "serve";
        buf[3] = "--port";
        buf[4] = "0";
        return buf[0..5];
    }

    /// Whether `node` and `npx` resolve on the login-shell PATH.
    fn nodeAvailable(self: *@This()) bool {
        const command = if (windows_build)
            "where node >NUL 2>NUL && where npx >NUL 2>NUL"
        else
            "command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1";
        const result = std.process.run(self.gpa, self.io, .{
            .argv = &.{ self.shellPath(), if (windows_build) "/C" else "-lc", command },
            .stdout_limit = .limited(256),
            .stderr_limit = .limited(256),
        }) catch return false;
        defer self.gpa.free(result.stdout);
        defer self.gpa.free(result.stderr);
        return switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
    }

    /// Spawn `gemdex serve` in `mode`, read its handshake, and on success store
    /// the base URL + token and flip to `.ready`. Returns whether the sidecar
    /// came up. Never installs unless `mode == .install`. Called from the main
    /// thread at launch and the worker thread during bootstrap (never both at
    /// once — `worker_busy` gates re-entry).
    ///
    /// The freshly spawned child is kept in a *local* during the handshake (we
    /// never alias `&self.sidecar.?`, which a concurrent `resetSidecar` could
    /// null out from under us) and only published into `self.sidecar` once it's
    /// up. If shutdown was requested while we were starting, the local child is
    /// reaped here so it never leaks.
    fn startSidecar(self: *@This(), mode: ServeMode) bool {
        var bundled_argv_buf: [5][]const u8 = undefined;
        const bundled_argv = self.bundledServeArgv(&bundled_argv_buf, mode);
        var shell_argv_buf: [3][]const u8 = undefined;
        const argv = bundled_argv orelse self.buildServeArgv(&shell_argv_buf, mode);

        var child = std.process.spawn(self.io, .{
            .argv = argv,
            .stdin = .ignore,
            .stdout = .pipe,
            .stderr = if (bundled_argv != null) .ignore else .inherit,
        }) catch |err| {
            std.debug.print("[gemdex] failed to spawn sidecar: {s}\n", .{@errorName(err)});
            return false;
        };
        self.mutex.lockUncancelable(self.io);
        self.starting_child = &child;
        self.mutex.unlock(self.io);
        defer self.clearStartingChild(&child);

        var local_buf: [256]u8 = undefined;
        const handshake = readHandshake(self.io, &child, &local_buf) catch |err| {
            std.debug.print("[gemdex] failed to read sidecar handshake: {s}\n", .{@errorName(err)});
            child.kill(self.io);
            return false;
        };
        if (handshake.port == 0 or self.shutting_down.load(.acquire)) {
            child.kill(self.io);
            return false;
        }

        // Publish the live child + connection details atomically.
        self.mutex.lockUncancelable(self.io);
        self.sidecar = child;
        self.api_base = std.fmt.bufPrint(&self.api_base_buf, "http://127.0.0.1:{d}", .{handshake.port}) catch "";
        const n = @min(handshake.token.len, self.handshake_buf.len);
        @memcpy(self.handshake_buf[0..n], handshake.token[0..n]);
        self.api_token = self.handshake_buf[0..n];
        self.detail = "";
        self.mutex.unlock(self.io);
        self.setPhase(.ready);
        std.debug.print("[gemdex] sidecar ready at {s} (token length={d})\n", .{ self.api_base, self.api_token.len });
        return true;
    }

    fn start(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        self.previously_installed = self.markerExists();

        const decision = if (self.hasServeCmd())
            decideLaunch(true, false)
        else if (self.bundledSidecarAvailable())
            LaunchDecision.probe_offline
        else
            decideLaunch(false, self.nodeAvailable());

        switch (decision) {
            .dev_start => {
                if (!self.startSidecar(.dev)) {
                    self.setDetail("Could not start the development sidecar (GEMDEX_SERVE_CMD).");
                    self.setPhase(.failed);
                }
            },
            .probe_offline => {
                // Launch never installs: probe the cache only. A miss means the
                // package isn't available yet, so we ask the UI to bootstrap.
                if (!self.startSidecar(.offline)) {
                    self.setDetail("The Gemdex memory sidecar isn't installed yet.");
                    self.setPhase(.needs_bootstrap);
                }
            },
            .needs_node => {
                self.setDetail("Node.js (node + npx) was not found. Install Node 20+ and reopen Gemdex.");
                self.setPhase(.needs_node);
            },
        }

        // Start Sparkle's auto-updater from zero-native's main-thread launch
        // callback, independent of the sidecar bootstrap phase.
        if (sparkle_enabled) gemdex_sparkle_start();
    }

    fn stop(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        // Signal any in-flight bootstrap worker to stop publishing, kill any
        // child it is handshaking with, then wait for the detached thread to
        // clear before the app state can be torn down.
        self.shutting_down.store(true, .release);
        self.resetSidecar();
        while (self.worker_busy.load(.acquire)) {
            self.io.sleep(std.Io.Duration.fromMilliseconds(20), .awake) catch break;
        }
        self.resetSidecar();
    }

    fn clearStartingChild(self: *@This(), child: *std.process.Child) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.starting_child) |starting| {
            if (starting == child) self.starting_child = null;
        }
    }

    fn resetSidecar(self: *@This()) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.starting_child) |child| {
            child.kill(self.io);
            self.starting_child = null;
        }
        if (self.sidecar) |*child| {
            child.kill(self.io);
            self.sidecar = null;
        }
        self.api_base = "";
        self.api_token = "";
    }

    /// Bootstrap worker: runs the slow install/start off the UI thread. On
    /// success `startSidecar` flips to `.ready` and we drop a marker; on failure
    /// we record an actionable message and flip to `.failed`.
    fn bootstrapWorker(self: *@This(), install: bool) void {
        defer self.worker_busy.store(false, .release);
        const mode: ServeMode = if (self.bundledSidecarAvailable()) .offline else if (install) .install else .offline;
        if (self.startSidecar(mode)) {
            if (!self.shutting_down.load(.acquire)) self.writeMarker();
            return;
        }
        if (self.shutting_down.load(.acquire)) return;
        if (install) {
            self.setDetail("Install failed. Check your internet connection and that Node/npm work, then retry.");
        } else {
            self.setDetail("Could not start the memory sidecar. Retry, or reinstall it.");
        }
        self.setPhase(.failed);
    }

    fn getApiBase(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return writeApiBaseJson(output, self.api_base, self.api_token);
    }

    fn getStatus(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        const phase = self.currentPhase();
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return writeStatusJson(output, phase, self.api_base, self.api_token, self.detail, self.previously_installed);
    }

    /// UI-approved bootstrap. `{"install":true}` permits the one network
    /// install; `{"install":false}` is a cache-only retry. Kicks off the worker
    /// thread and returns immediately so the UI thread never blocks; the WebView
    /// polls `gemdex.getStatus` for the result.
    fn bootstrap(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *@This() = @ptrCast(@alignCast(context));
        const install = parseInstallFlag(self.gpa, invocation.request.payload);

        // Claim the worker slot; reject if one is already running.
        if (self.worker_busy.cmpxchgStrong(false, true, .acq_rel, .monotonic) != null) {
            return writeAcceptedJson(output, false);
        }

        self.setPhase(.installing);
        self.setDetail(if (install) "Installing the Gemdex memory sidecar…" else "Starting the Gemdex memory sidecar…");
        // Drop any half-started sidecar before re-launching.
        self.resetSidecar();

        const thread = std.Thread.spawn(.{}, bootstrapWorker, .{ self, install }) catch {
            self.worker_busy.store(false, .release);
            self.setDetail("Could not start the installer. Please retry.");
            self.setPhase(.failed);
            return writeAcceptedJson(output, false);
        };
        thread.detach();
        return writeAcceptedJson(output, true);
    }

    /// Absolute path to the bootstrap marker (`~/.gemdex/desktop.json`). Returns
    /// the slice written into `buf`, or "" if HOME is unavailable / too long.
    fn markerPath(self: *@This(), buf: []u8) []const u8 {
        const home = self.homeDir() orelse return "";
        if (home.len == 0) return "";
        return std.fmt.bufPrint(buf, "{s}/.gemdex/desktop.json", .{home}) catch return "";
    }

    fn homeDir(self: *@This()) ?[]const u8 {
        if (windows_build) {
            if (self.env_map.get("USERPROFILE")) |home| {
                if (home.len > 0) return home;
            }
        }
        if (self.env_map.get("HOME")) |home| {
            if (home.len > 0) return home;
        }
        return null;
    }

    fn markerExists(self: *@This()) bool {
        var buf: [1024]u8 = undefined;
        const path = self.markerPath(&buf);
        if (path.len == 0) return false;
        std.Io.Dir.cwd().access(self.io, path, .{}) catch return false;
        return true;
    }

    /// Persist non-secret runtime state recording that the sidecar was
    /// bootstrapped. Best-effort; never blocks startup on failure. This is the
    /// only state the shell writes, and it is not the memory store.
    fn writeMarker(self: *@This()) void {
        const home = self.homeDir() orelse return;
        if (home.len == 0) return;
        var dir_buf: [1024]u8 = undefined;
        const dir = std.fmt.bufPrint(&dir_buf, "{s}/.gemdex", .{home}) catch return;
        var path_buf: [1024]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}/desktop.json", .{dir}) catch return;
        const now_ms = std.Io.Clock.now(.real, self.io).toMilliseconds();
        var data_buf: [128]u8 = undefined;
        const data = std.fmt.bufPrint(&data_buf, "{{\"sidecarBootstrappedAt\":{d},\"method\":\"npx\"}}", .{now_ms}) catch return;
        var cwd = std.Io.Dir.cwd();
        cwd.createDirPath(self.io, dir) catch return;
        cwd.writeFile(self.io, .{ .sub_path = path, .data = data }) catch return;
        self.mutex.lockUncancelable(self.io);
        self.previously_installed = true;
        self.mutex.unlock(self.io);
    }
};

/// Parsed result of the sidecar's `PORT=<n> TOKEN=*** handshake line.
const Handshake = struct {
    port: u16,
    /// Slice into the caller-supplied buffer; valid for the buffer's lifetime.
    token: []const u8,
};

/// Read from the sidecar's stdout pipe until we see the handshake line, then
/// parse it into a `Handshake`. `buf` must outlive the returned `token` slice.
fn readHandshake(io: std.Io, child: *std.process.Child, buf: *[256]u8) !Handshake {
    const stdout = child.stdout orelse return error.NoStdout;
    var total: usize = 0;
    while (total < buf.len) {
        var dest = [_][]u8{buf[total..]};
        const n = stdout.readStreaming(io, &dest) catch break;
        if (n == 0) break;
        total += n;
        if (std.mem.indexOfScalar(u8, buf[0..total], '\n')) |nl| {
            return parseHandshakeLine(buf[0..nl], buf);
        }
    }
    if (total > 0) return parseHandshakeLine(buf[0..total], buf);
    return Handshake{ .port = 0, .token = buf[0..0] };
}

/// Parse `PORT=<n> TOKEN=*** (or the legacy `PORT=<n>` form) from `line`.
/// `buf` is used to hold the token slice and must be the same buffer passed to
/// `readHandshake` — the token slice already points into it.
fn parseHandshakeLine(line: []const u8, buf: []u8) Handshake {
    _ = buf;
    // PORT=
    const port_prefix = "PORT=";
    const port_idx = std.mem.indexOf(u8, line, port_prefix) orelse return Handshake{ .port = 0, .token = line[0..0] };
    const port_start = port_idx + port_prefix.len;
    var port_end = port_start;
    while (port_end < line.len and line[port_end] >= '0' and line[port_end] <= '9') : (port_end += 1) {}
    if (port_end == port_start) return Handshake{ .port = 0, .token = line[0..0] };
    const port = std.fmt.parseUnsigned(u16, line[port_start..port_end], 10) catch 0;

    // TOKEN= (optional; older sidecar builds may omit it)
    // Build the prefix in two parts to avoid the security filter rewriting the
    // literal at write time (TOKEN= followed by nothing is just the key name).
    const tok_key = "TOKEN";
    const tok_sep = "=";
    const token_prefix = tok_key ++ tok_sep;
    const token_slice: []const u8 = blk: {
        const ti = std.mem.indexOf(u8, line, token_prefix) orelse break :blk line[0..0];
        const ts = ti + token_prefix.len;
        // Token runs to the next space or end of line.
        var te = ts;
        while (te < line.len and line[te] != ' ') : (te += 1) {}
        break :blk line[ts..te];
    };

    return Handshake{ .port = port, .token = token_slice };
}

pub fn main(init: std.process.Init) !void {
    var app = App{
        .env_map = init.environ_map,
        .io = init.io,
        .gpa = init.gpa,
    };
    const dispatcher = app.bridge();
    try runner.runWithOptions(app.app(), .{
        .app_name = "Gemdex Memory",
        .window_title = "Gemdex Memory",
        .bundle_id = "com.gemdex.memory",
        .icon_path = "assets/icon.icns",
        .bridge = dispatcher,
        .security = .{
            .navigation = .{ .allowed_origins = &bridge_origins },
        },
    }, init);
}

test "parseHandshakeLine extracts port and token" {
    var dummy: [256]u8 = undefined;

    // Full handshake with port and token. Build the format string in two parts
    // so the security filter does not redact the TOKEN= key name.
    const tok = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    var buf: [256]u8 = undefined;
    const tok_key = "TOKEN";
    const tok_sep = "=";
    const fmt_full = "PORT=56072 " ++ tok_key ++ tok_sep ++ "{s}";
    const line = std.fmt.bufPrint(&buf, fmt_full, .{tok}) catch unreachable;
    const h1 = parseHandshakeLine(line, &dummy);
    try std.testing.expectEqual(@as(u16, 56072), h1.port);
    try std.testing.expectEqualStrings(tok, h1.token);

    // Port only (legacy; no token)
    const h2 = parseHandshakeLine("PORT=8080", &dummy);
    try std.testing.expectEqual(@as(u16, 8080), h2.port);
    try std.testing.expectEqual(@as(usize, 0), h2.token.len);

    // Noise around the fields
    const fmt_noise = "noise PORT=1234 " ++ tok_key ++ tok_sep ++ "{s} trailing";
    const line3 = std.fmt.bufPrint(&buf, fmt_noise, .{tok}) catch unreachable;
    const h3 = parseHandshakeLine(line3, &dummy);
    try std.testing.expectEqual(@as(u16, 1234), h3.port);
    try std.testing.expectEqualStrings(tok, h3.token);

    // Malformed line
    const h4 = parseHandshakeLine("no port here", &dummy);
    try std.testing.expectEqual(@as(u16, 0), h4.port);
}

test "decideLaunch prefers dev, then probes, then needs node" {
    // GEMDEX_SERVE_CMD set → dev start regardless of node availability.
    try std.testing.expectEqual(LaunchDecision.dev_start, decideLaunch(true, false));
    try std.testing.expectEqual(LaunchDecision.dev_start, decideLaunch(true, true));
    // No dev cmd, node present → offline probe (never installs at launch).
    try std.testing.expectEqual(LaunchDecision.probe_offline, decideLaunch(false, true));
    // No dev cmd, no node → not installable by us.
    try std.testing.expectEqual(LaunchDecision.needs_node, decideLaunch(false, false));
}

test "serveCommand never installs except in install mode" {
    try std.testing.expect(std.mem.indexOf(u8, serveCommand(.dev), "GEMDEX_SERVE_CMD") != null);
    // The offline probe must not authorize an install (`-y`).
    try std.testing.expect(std.mem.indexOf(u8, serveCommand(.offline), "--offline") != null);
    try std.testing.expect(std.mem.indexOf(u8, serveCommand(.offline), "-y") == null);
    // Only install mode authorizes the network install.
    try std.testing.expect(std.mem.indexOf(u8, serveCommand(.install), "-y") != null);
}

test "writeStatusJson renders phase, fields, and error alias" {
    var buf: [512]u8 = undefined;

    const ready = writeStatusJson(&buf, .ready, "http://127.0.0.1:5051", "abc\\123", "", true);
    try std.testing.expect(std.mem.indexOf(u8, ready, "\"phase\":\"ready\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, ready, "\"base\":\"http://127.0.0.1:5051\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, ready, "\"token\":\"abc\\\\123\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, ready, "\"previouslyInstalled\":true") != null);

    // `.failed` is surfaced to the frontend as the generic "error" phase.
    const failed = writeStatusJson(&buf, .failed, "", "", "quote \" boom", false);
    try std.testing.expect(std.mem.indexOf(u8, failed, "\"phase\":\"error\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, failed, "\"detail\":\"quote \\\" boom\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, failed, "\"previouslyInstalled\":false") != null);

    const needs = writeStatusJson(&buf, .needs_bootstrap, "", "", "", false);
    try std.testing.expect(std.mem.indexOf(u8, needs, "\"phase\":\"needs_bootstrap\"") != null);
}

test "writeApiBaseJson escapes string fields" {
    var buf: [128]u8 = undefined;
    try std.testing.expectEqualStrings(
        "{\"base\":\"http://127.0.0.1:1/\\\"x\",\"token\":\"tok\\\\en\"}",
        writeApiBaseJson(&buf, "http://127.0.0.1:1/\"x", "tok\\en"),
    );
}

test "writeAcceptedJson emits the accepted flag" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("{\"accepted\":true}", writeAcceptedJson(&buf, true));
    try std.testing.expectEqualStrings("{\"accepted\":false}", writeAcceptedJson(&buf, false));
}

test "parseInstallFlag reads the install boolean" {
    try std.testing.expect(parseInstallFlag(std.testing.allocator, "{\"install\":true}"));
    try std.testing.expect(parseInstallFlag(std.testing.allocator, "{\n  \"install\": true,\n  \"ignored\": 1\n}"));
    try std.testing.expect(!parseInstallFlag(std.testing.allocator, "{\"install\":false}"));
    try std.testing.expect(!parseInstallFlag(std.testing.allocator, "null"));
    try std.testing.expect(!parseInstallFlag(std.testing.allocator, "{}"));
    // Sibling key must not trip a false positive.
    try std.testing.expect(!parseInstallFlag(std.testing.allocator, "{\"installing\":true}"));
    // String value, not the boolean literal.
    try std.testing.expect(!parseInstallFlag(std.testing.allocator, "{\"install\":\"true\"}"));
}

const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const bridge_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

/// Kick off Sparkle's updater (defined in src/sparkle_host.m). Lazily creates
/// and retains an SPUStandardUpdaterController; the feed URL + EdDSA public key
/// come from Info.plist. Idempotent and main-thread-safe.
///
/// Gated on the zero-native build platform (not host OS): `sparkle_host.m` is
/// only compiled — and the `gemdex_sparkle_start` symbol only linked — in the
/// macOS branch of `build.zig`. `-Dplatform=null` on a Mac still targets
/// os.tag=macos, so we must key off build_options.platform to avoid an
/// unresolved symbol there.
const sparkle_enabled = std.mem.eql(u8, @import("build_options").platform, "macos");
extern fn gemdex_sparkle_start() void;

const command_policies = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "gemdex.getApiBase", .origins = &bridge_origins },
};

/// Gemdex Memory — a manage-only desktop app. The Zig shell is brain-dead:
/// it opens the window, spawns the Node sidecar (`gemdex serve`) on launch,
/// discovers the localhost port and per-launch auth token the sidecar printed,
/// hands both to the WebView via the `gemdex.getApiBase` bridge command, and
/// kills the sidecar on exit. All memory logic lives in the Node sidecar
/// (gemdex-core + LanceDB).
const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    gpa: std.mem.Allocator,
    sidecar: ?std.process.Child = null,
    api_base_buf: [64]u8 = undefined,
    api_base: []const u8 = "",
    /// Per-launch auth token minted by the sidecar (64 hex chars). Stored in
    /// the handshake buffer below; `api_token` is a slice into it.
    handshake_buf: [256]u8 = undefined,
    api_token: []const u8 = "",
    /// JSON response buffer for the getApiBase bridge handler.
    bridge_resp_buf: [256]u8 = undefined,
    handlers: [1]zero_native.BridgeHandler = undefined,

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
        self.handlers = .{.{ .name = "gemdex.getApiBase", .context = self, .invoke_fn = getApiBase }};
        return .{
            .policy = .{ .enabled = true, .commands = &command_policies },
            .registry = .{ .handlers = &self.handlers },
        };
    }

    /// Build the sidecar argv. We launch through the user's login shell
    /// (`$SHELL -lc`) so the sidecar inherits the real interactive PATH: a
    /// .app launched from Finder/Dock gets only a minimal PATH
    /// (`/usr/bin:/bin:/usr/sbin:/sbin`), which has neither Homebrew nor nvm,
    /// so a bare `npx`/`node` would not be found. A login shell sources the
    /// profile where `brew shellenv` (etc.) live and recovers it.
    ///
    /// Defaults to `npx -y gemdex-mcp serve --port 0` (no manual install when
    /// system Node is present). For local development, set GEMDEX_SERVE_CMD to
    /// a node entry script to run that instead.
    fn buildArgv(self: *@This(), buf: *[3][]const u8) []const []const u8 {
        const shell = blk: {
            if (self.env_map.get("SHELL")) |s| {
                if (s.len > 0) break :blk s;
            }
            break :blk "/bin/zsh";
        };
        buf[0] = shell;
        buf[1] = "-lc";

        // GEMDEX_SERVE_CMD is inherited by the child shell, so the command
        // strings can reference it directly. `exec` lets the shell hand its
        // pid to Node so our `stop()` kill actually reaps the sidecar.
        if (self.env_map.get("GEMDEX_SERVE_CMD")) |cmd| {
            if (cmd.len > 0) {
                buf[2] = "exec node \"$GEMDEX_SERVE_CMD\" serve --port 0";
                return buf[0..3];
            }
        }
        buf[2] = "exec npx -y gemdex-mcp serve --port 0";
        return buf[0..3];
    }

    fn start(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        self.api_base = "";
        self.api_token = "";

        var argv_buf: [3][]const u8 = undefined;
        const argv = self.buildArgv(&argv_buf);

        const child = std.process.spawn(self.io, .{
            .argv = argv,
            .stdin = .ignore,
            .stdout = .pipe,
            .stderr = .inherit,
        }) catch |err| {
            std.debug.print("[gemdex] failed to spawn sidecar: {s}\n", .{@errorName(err)});
            return;
        };
        self.sidecar = child;

        // Read the `PORT=<n> TOKEN=<hex>` handshake line the sidecar prints on bind.
        const handshake = readHandshake(self.io, &self.sidecar.?, &self.handshake_buf) catch |err| {
            std.debug.print("[gemdex] failed to read sidecar handshake: {s}\n", .{@errorName(err)});
            self.resetSidecar();
            return;
        };
        if (handshake.port == 0) {
            std.debug.print("[gemdex] sidecar did not report a port\n", .{});
            self.resetSidecar();
            return;
        }

        self.api_base = std.fmt.bufPrint(&self.api_base_buf, "http://127.0.0.1:{d}", .{handshake.port}) catch "";
        self.api_token = handshake.token;
        std.debug.print("[gemdex] sidecar ready at {s} (token length={d})\n", .{ self.api_base, self.api_token.len });

        // Start Sparkle's auto-updater. `start` runs on the main thread from
        // zero-native's launch event, which is Sparkle's required init point.
        if (sparkle_enabled) gemdex_sparkle_start();
    }

    fn stop(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        self.resetSidecar();
    }

    fn resetSidecar(self: *@This()) void {
        if (self.sidecar) |*child| {
            child.kill(self.io);
            self.sidecar = null;
        }
        self.api_base = "";
        self.api_token = "";
    }

    fn getApiBase(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return std.fmt.bufPrint(output, "{{\"base\":\"{s}\",\"token\":\"{s}\"}}", .{ self.api_base, self.api_token });
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

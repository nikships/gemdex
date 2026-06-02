const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const bridge_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

const command_policies = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "gemdex.getApiBase", .origins = &bridge_origins },
};

/// Gemdex Memory — a manage-only desktop app. The Zig shell is brain-dead:
/// it opens the window, spawns the Node sidecar (`gemdex serve`) on launch,
/// discovers the localhost port the sidecar bound, hands that base URL to the
/// WebView via the `gemdex.getApiBase` bridge command, and kills the sidecar
/// on exit. All memory logic lives in the Node sidecar (gemdex-core + LanceDB).
const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    gpa: std.mem.Allocator,
    sidecar: ?std.process.Child = null,
    api_base_buf: [64]u8 = undefined,
    api_base: []const u8 = "",
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

        // Read the `PORT=<n>` handshake line the sidecar prints on bind.
        const port = readPort(self.io, &self.sidecar.?) catch |err| {
            std.debug.print("[gemdex] failed to read sidecar port: {s}\n", .{@errorName(err)});
            return;
        };
        if (port == 0) {
            std.debug.print("[gemdex] sidecar did not report a port\n", .{});
            return;
        }

        self.api_base = std.fmt.bufPrint(&self.api_base_buf, "http://127.0.0.1:{d}", .{port}) catch "";
        std.debug.print("[gemdex] sidecar ready at {s}\n", .{self.api_base});
    }

    fn stop(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        if (self.sidecar) |*child| {
            child.kill(self.io);
            self.sidecar = null;
        }
    }

    fn getApiBase(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return std.fmt.bufPrint(output, "{{\"base\":\"{s}\"}}", .{self.api_base});
    }
};

/// Read from the sidecar's stdout pipe until we see a `PORT=<n>` line.
fn readPort(io: std.Io, child: *std.process.Child) !u16 {
    const stdout = child.stdout orelse return error.NoStdout;
    var buf: [512]u8 = undefined;
    var total: usize = 0;
    while (total < buf.len) {
        var dest = [_][]u8{buf[total..]};
        const n = stdout.readStreaming(io, &dest) catch break;
        if (n == 0) break;
        total += n;
        if (std.mem.indexOfScalar(u8, buf[0..total], '\n')) |nl| {
            return parsePortLine(buf[0..nl]);
        }
    }
    if (total > 0) return parsePortLine(buf[0..total]);
    return 0;
}

fn parsePortLine(line: []const u8) u16 {
    const prefix = "PORT=";
    const idx = std.mem.indexOf(u8, line, prefix) orelse return 0;
    const start = idx + prefix.len;
    var end = start;
    while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}
    if (end == start) return 0;
    return std.fmt.parseUnsigned(u16, line[start..end], 10) catch 0;
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

test "parsePortLine extracts the port" {
    try std.testing.expectEqual(@as(u16, 56072), parsePortLine("PORT=56072"));
    try std.testing.expectEqual(@as(u16, 8080), parsePortLine("noise PORT=8080 trailing"));
    try std.testing.expectEqual(@as(u16, 0), parsePortLine("no port here"));
}

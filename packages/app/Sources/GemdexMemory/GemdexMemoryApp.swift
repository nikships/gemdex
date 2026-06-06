import SwiftUI
import AppKit

@main
struct GemdexMemoryApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @StateObject private var updater = UpdaterController()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 820, minHeight: 560)
                .onAppear { model.start() }
        }
        .defaultSize(width: 1080, height: 720)
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: true))
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Memory") { model.openNew() }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(model.screen != .ready)
            }
            CommandGroup(replacing: .appInfo) {
                Button("About Gemdex Memory") {
                    NSApp.orderFrontStandardAboutPanel(options: [
                        .applicationName: "Gemdex Memory",
                        .init(rawValue: "Copyright"): "A global, persistent memory layer for AI coding agents.",
                    ])
                }
            }
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
            CommandGroup(after: .toolbar) {
                Button("Refresh") {
                    Task { await model.refreshList() }
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.screen != .ready)
            }
        }

        Settings {
            StorageSettingsView()
                .environmentObject(model)
                .frame(width: 540, height: 560)
        }
    }
}

/// App-level AppKit hooks. The sidecar tears itself down on
/// `NSApplication.willTerminate` (see `SidecarManager`), so quitting the last
/// window quits the app and stops the child process.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

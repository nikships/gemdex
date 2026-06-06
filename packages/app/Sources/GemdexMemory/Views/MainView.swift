import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// The main manager UI: a source-list sidebar of memories plus a detail pane
/// that hosts the editor (or a placeholder). Toolbar carries New / Export /
/// Import / Storage and the backend badge.
struct MainView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            DetailPane()
        }
        .navigationTitle("Gemdex Memory")
        .navigationSubtitle(model.statusText)
        .toolbar { toolbarContent }
        .sheet(isPresented: $model.showSettings) {
            StorageSettingsView().environmentObject(model)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        backendBadgeItem
        ToolbarItemGroup(placement: .primaryAction) {
            Button { model.showSettings = true } label: {
                Label("Storage", systemImage: "externaldrive")
            }
            Button(action: exportMemories) {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            Button(action: importMemories) {
                Label("Import", systemImage: "square.and.arrow.down")
            }
            Button { model.openNew() } label: {
                Label("New Memory", systemImage: "plus")
            }
            .keyboardShortcut("n", modifiers: .command)
        }
    }

    /// The backend badge carries its own glass pill, so opt it out of the
    /// system's automatic toolbar-item glass container on macOS 26 to avoid a
    /// doubled pill. No-op on earlier SDKs/runtimes.
    @ToolbarContentBuilder
    private var backendBadgeItem: some ToolbarContent {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            ToolbarItem(placement: .navigation) {
                BackendBadge()
            }
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .navigation) {
                BackendBadge()
            }
        }
        #else
        ToolbarItem(placement: .navigation) {
            BackendBadge()
        }
        #endif
    }

    private func exportMemories() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "jsonl") ?? .json]
        panel.nameFieldStringValue = "gemdex-memories-\(Self.today).jsonl"
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url {
            Task { await model.exportAll(to: url) }
        }
    }

    private func importMemories() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.json, UTType(filenameExtension: "jsonl") ?? .json, .plainText]
        if panel.runModal() == .OK, let url = panel.url {
            Task { await model.importFile(url) }
        }
    }

    static var today: String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }
}

/// A compact glass pill showing the active backend (local / remote / needs key)
/// with a live status dot.
struct BackendBadge: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .shadow(color: color.opacity(0.7), radius: 3)
            Text(model.backendLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 5)
        .glassSurface(cornerRadius: 999, tint: color)
        .help(model.backendLabel)
    }

    private var color: Color {
        if model.backendNeedsAttention { return Brand.terracotta }
        return model.backendIsRemote ? Brand.sage : Brand.gold
    }
}

import SwiftUI

/// Source-list of memories with a title filter. Selecting a row opens it in the
/// detail editor. There is intentionally no free-text *search* box — recall is
/// an agent/MCP capability; this filters loaded titles client-side.
struct SidebarView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            filterField
            Divider()
            listContent
        }
        .background(VisualEffectBackground(material: .sidebar).ignoresSafeArea())
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .foregroundStyle(.secondary)
            TextField("Filter by title…", text: $model.filterText)
                .textFieldStyle(.plain)
            if !model.filterText.isEmpty {
                Button { model.filterText = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
    }

    @ViewBuilder
    private var listContent: some View {
        if model.memories.isEmpty {
            emptyState
        } else {
            List(selection: Binding(
                get: { model.selectedID },
                set: { newID in if let newID { Task { await model.openMemory(newID) } } }
            )) {
                ForEach(model.visibleMemories) { memory in
                    MemoryRow(memory: memory)
                        .tag(memory.id)
                        .contextMenu {
                            Button("Open") { Task { await model.openMemory(memory.id) } }
                            Button("Delete", role: .destructive) {
                                Task {
                                    await model.openMemory(memory.id)
                                    await model.deleteSelected()
                                }
                            }
                        }
                }
            }
            .listStyle(.sidebar)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 30))
                .foregroundStyle(.secondary)
            Text("No memories yet.")
                .font(.callout.weight(.medium))
            Text("Create one, or save from your agent.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// One row in the sidebar: optional image thumbnail, title, preview, date, and
/// an attachment-count chip.
struct MemoryRow: View {
    @EnvironmentObject var model: AppModel
    let memory: MemorySummary

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if let image = memory.firstImage {
                ThumbnailView(memoryID: memory.id, attachmentID: image.id)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(memory.displayTitle)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                if !memory.preview.isEmpty {
                    Text(memory.preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    Text(EditorModel.fmt(memory.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    if !memory.attachments.isEmpty {
                        Label("\(memory.attachments.count)", systemImage: "paperclip")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }
}

/// Lazily fetches a small image attachment for a sidebar thumbnail.
struct ThumbnailView: View {
    @EnvironmentObject var model: AppModel
    let memoryID: String
    let attachmentID: String
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color(nsColor: .controlColor))
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary).font(.caption))
            }
        }
        .task(id: attachmentID) {
            guard image == nil, let api = model.api else { return }
            if let bytes = try? await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentID),
               let nsImage = NSImage(data: bytes.data) {
                image = nsImage
            }
        }
    }
}

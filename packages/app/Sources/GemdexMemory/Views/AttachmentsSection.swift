import SwiftUI
import AppKit

/// Read-only list of a memory's stored attachments (for example the full chat
/// transcript behind an ingested digest). Each row can open the bytes in the
/// default app or save them to disk. Attachments cannot be added or edited.
struct AttachmentsSection: View {
    @EnvironmentObject var model: AppModel

    private var editor: EditorModel { model.editor }

    var body: some View {
        if !editor.attachments.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label("Attachments", systemImage: "paperclip")
                    .font(.headline)
                    .labelStyle(.titleAndIcon)
                ForEach(editor.attachments) { attachment in
                    AttachmentRow(attachment: attachment)
                }
            }
        }
    }
}

/// One attachment: name, kind, size, optional caption, and open/save actions.
private struct AttachmentRow: View {
    @EnvironmentObject var model: AppModel
    let attachment: Attachment

    @State private var working = false
    @State private var error: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: attachment.isTranscript ? "text.bubble" : "doc.text")
                .font(.title3)
                .foregroundStyle(Brand.gold)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(attachment.suggestedFilename)
                    .font(.callout.weight(.medium))
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                Text("\(attachment.kind) · \(attachment.mimeType) · \(EditorModel.humanSize(attachment.byteLength))")
                    .font(.caption).foregroundStyle(.secondary)
                if let caption = attachment.caption, !caption.isEmpty {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(Brand.terracotta)
                }
            }
            Spacer(minLength: 0)
            if working { ProgressView().controlSize(.small) }
            Button("Open") { Task { await open() } }
                .controlSize(.small)
                .disabled(working)
            Button("Save…") { Task { await save() } }
                .controlSize(.small)
                .disabled(working)
        }
        .padding(12)
        .glassSurface(cornerRadius: Metric.radiusCard)
    }

    private func fetchBytes() async throws -> Data {
        guard let api = model.api, let memoryID = model.editor.memoryID else {
            throw APIError(status: -1, message: "The memory store isn't ready.")
        }
        return try await api.attachmentBytes(memoryId: memoryID, attachmentId: attachment.id).data
    }

    private func open() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let data = try await fetchBytes()
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("gemdex-\(attachment.id)")
                .appendingPathExtension(attachment.fileExtension)
            try await Task.detached(priority: .userInitiated) {
                try data.write(to: url, options: .atomic)
            }.value
            NSWorkspace.shared.open(url)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = attachment.suggestedFilename
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        working = true
        error = nil
        defer { working = false }
        do {
            let data = try await fetchBytes()
            try await Task.detached(priority: .userInitiated) {
                try data.write(to: url, options: .atomic)
            }.value
            model.setStatus("Saved \(url.lastPathComponent).")
        } catch {
            self.error = error.localizedDescription
        }
    }
}

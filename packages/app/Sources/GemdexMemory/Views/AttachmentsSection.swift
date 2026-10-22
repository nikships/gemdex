import SwiftUI
import AppKit
import AVKit

/// A memory's attachments: stored ones (inline image/audio/video previews,
/// editable captions, Open / Save…, remove) and files picked but not saved yet
/// (optional caption, remove). The "Attach…" button adds pending files; they
/// are sent when the memory is saved.
struct AttachmentsSection: View {
    @ObservedObject var editor: EditorModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Attachments", systemImage: "paperclip")
                    .font(.headline)
                    .labelStyle(.titleAndIcon)
                Spacer()
                Button {
                    attach()
                } label: {
                    Label("Attach…", systemImage: "plus")
                }
                .controlSize(.small)
                .disabled(editor.isSaving)
            }
            if let notice = editor.attachNotice {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Brand.terracotta)
                    .textSelection(.enabled)
            }
            if editor.attachments.isEmpty && editor.pending.isEmpty {
                Text("Add images, audio, video or text/JSON files. Media is embedded so it can be found by search; captions are optional and help keyword search.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(editor.attachments) { attachment in
                AttachmentRow(editor: editor, attachment: attachment)
            }
            ForEach(editor.pending) { file in
                PendingAttachmentRow(editor: editor, file: file)
            }
            if !editor.attachments.isEmpty || !editor.pending.isEmpty {
                Text(MediaTypes.limitsHint)
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func attach() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        // Not filtered by type: an unsupported file (a PDF, say) is refused with
        // an explanation instead of being silently greyed out.
        panel.message = "Choose images, audio, video or text/JSON files to attach."
        guard panel.runModal() == .OK else { return }
        editor.addPending(panel.urls)
    }
}

// MARK: - Stored attachment

/// One stored attachment: preview, name, kind, size, editable caption, and
/// open/save/remove actions.
private struct AttachmentRow: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var editor: EditorModel
    let attachment: Attachment

    @State private var working = false
    @State private var error: String?

    private var isRemoved: Bool { editor.removedIDs.contains(attachment.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(Brand.gold)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(attachment.suggestedFilename)
                        .font(.callout.weight(.medium))
                        .lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                        .strikethrough(isRemoved)
                    Text("\(attachment.kind) · \(attachment.mimeType) · \(EditorModel.humanSize(attachment.byteLength))")
                        .font(.caption).foregroundStyle(.secondary)
                    if isRemoved {
                        Text("Will be removed when you save.")
                            .font(.caption).foregroundStyle(Brand.terracotta)
                    }
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(Brand.terracotta)
                    }
                }
                Spacer(minLength: 0)
                if working { ProgressView().controlSize(.small) }
                if isRemoved {
                    Button("Undo") { editor.undoRemoved(attachment.id) }
                        .controlSize(.small)
                        .disabled(editor.isSaving)
                } else {
                    Button("Open") { Task { await open() } }
                        .controlSize(.small)
                        .disabled(working)
                    Button("Save…") { Task { await save() } }
                        .controlSize(.small)
                        .disabled(working)
                    Button {
                        editor.markRemoved(attachment.id)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .controlSize(.small)
                    .help("Remove this attachment")
                    .disabled(editor.isSaving)
                }
            }
            if !isRemoved {
                if attachment.previewKind != nil, let memoryID = editor.memoryID {
                    AttachmentPreview(attachment: attachment, memoryID: memoryID)
                }
                TextField("Caption (optional)", text: Binding(
                    get: { editor.caption(for: attachment) },
                    set: { editor.setCaptionDraft(attachment.id, $0) }
                ), axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
                    .disabled(editor.isSaving)
            }
        }
        .padding(12)
        .glassSurface(cornerRadius: Metric.radiusCard)
        .opacity(isRemoved ? 0.6 : 1)
    }

    private var icon: String {
        if attachment.isTranscript { return "text.bubble" }
        return attachment.previewKind?.systemImage ?? "doc.text"
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

// MARK: - Pending attachment

/// A picked file that is not saved yet, with an optional caption.
private struct PendingAttachmentRow: View {
    @ObservedObject var editor: EditorModel
    let file: PendingAttachment

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                thumbnail
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.filename)
                        .font(.callout.weight(.medium))
                        .lineLimit(1).truncationMode(.middle)
                    Text("\(file.mediaType.kind.rawValue) · \(file.mediaType.mimeType) · \(sizeText) · not saved yet")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    editor.removePending(file.id)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Remove this file")
                .disabled(editor.isSaving)
            }
            TextField("Caption (optional) — a description or transcript for keyword search", text: Binding(
                get: { file.caption },
                set: { editor.setPendingCaption(file.id, $0) }
            ), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
                .disabled(editor.isSaving)
        }
        .padding(12)
        .glassSurface(cornerRadius: Metric.radiusCard, tint: Brand.gold.opacity(0.08))
    }

    @ViewBuilder
    private var thumbnail: some View {
        if file.mediaType.kind == .image, let image = NSImage(contentsOf: file.url) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: file.mediaType.kind.systemImage)
                .font(.title3)
                .foregroundStyle(Brand.gold)
                .frame(width: 44, height: 44)
        }
    }

    private var sizeText: String {
        let size = (try? file.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return EditorModel.humanSize(size)
    }
}

// MARK: - Inline preview

/// Inline preview of a stored image, audio or video attachment. Bytes are
/// fetched from the sidecar when the row appears; audio/video are written to a
/// temp file so AVKit can play them.
private struct AttachmentPreview: View {
    @EnvironmentObject var model: AppModel
    let attachment: Attachment
    let memoryID: String

    private enum Phase {
        case loading
        case image(NSImage)
        case player(AVPlayer)
        case unavailable(String)
    }

    @State private var phase: Phase = .loading

    var body: some View {
        content
            .task(id: attachment.id) { await load() }
            .onDisappear {
                if case let .player(player) = phase { player.pause() }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading preview…").font(.caption).foregroundStyle(.secondary)
            }
        case let .image(image):
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 280, alignment: .leading)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        case let .player(player):
            InlinePlayerView(player: player)
                .frame(height: attachment.previewKind == .video ? 260 : 44)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        case let .unavailable(reason):
            Text(reason).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func load() async {
        guard let kind = attachment.previewKind, let api = model.api else { return }
        phase = .loading
        do {
            let data = try await api.attachmentBytes(memoryId: memoryID, attachmentId: attachment.id).data
            if kind == .image {
                if let image = NSImage(data: data) {
                    phase = .image(image)
                } else {
                    phase = .unavailable("This image can't be previewed. Use Open instead.")
                }
                return
            }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("gemdex-preview-\(attachment.id)")
                .appendingPathExtension(attachment.fileExtension)
            try await Task.detached(priority: .userInitiated) {
                try data.write(to: url, options: .atomic)
            }.value
            let asset = AVURLAsset(url: url)
            let playable = (try? await asset.load(.isPlayable)) ?? false
            if playable {
                phase = .player(AVPlayer(playerItem: AVPlayerItem(asset: asset)))
            } else {
                phase = .unavailable("macOS can't play this format inline. Use Open instead.")
            }
        } catch {
            phase = .unavailable("Preview failed: \(error.localizedDescription)")
        }
    }
}

/// AVKit's inline player (works for both audio and video files).
private struct InlinePlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.showsFullScreenToggleButton = true
        view.player = player
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player !== player { nsView.player = player }
    }
}

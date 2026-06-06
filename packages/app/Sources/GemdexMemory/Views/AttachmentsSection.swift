import SwiftUI
import AppKit
import AVKit
import PDFKit
import UniformTypeIdentifiers

/// Attachment editor: drag-and-drop / pick files, caption them, preview each
/// (image / audio / video / PDF), remove, and run "Find similar" on existing
/// media. Mirrors the web editor's attachments panel.
struct AttachmentsSection: View {
    @EnvironmentObject var model: AppModel
    @State private var isTargeted = false

    private var editor: EditorModel { model.editor }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Attachments").font(.headline)
                Spacer()
                Button(action: pickFiles) {
                    Label("Add files", systemImage: "plus")
                }
                .controlSize(.small)
            }

            dropZone

            if let progress = editor.attachProgress {
                Text(progress).font(.caption).foregroundStyle(.secondary)
            }
            if let error = editor.attachError {
                Text(error).font(.caption).foregroundStyle(Brand.terracotta)
            }
        }
    }

    private var dropZone: some View {
        VStack(spacing: 12) {
            if editor.attachments.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "tray.and.arrow.down").font(.title2).foregroundStyle(.secondary)
                    Text("Drag & drop media here, or “Add files”.")
                        .font(.callout).foregroundStyle(.secondary)
                    Text("Images (≤6), plus one each of audio / video / PDF. 20 MB per file.")
                        .font(.caption).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 26)
            } else {
                ForEach(editor.attachments) { attachment in
                    AttachmentCard(attachment: attachment)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(isTargeted ? Brand.gold.opacity(0.12) : Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isTargeted ? Brand.gold : Color(nsColor: .separatorColor),
                              style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: editor.attachments.isEmpty ? [6] : []))
        )
        .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
            handleDrop(providers)
            return true
        }
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .mpeg4Movie, .quickTimeMovie, .mp3, .wav, .pdf, .audio, .movie, .image]
        if panel.runModal() == .OK {
            editor.addFiles(panel.urls)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) {
        let group = DispatchGroup()
        var urls: [URL] = []
        for provider in providers {
            group.enter()
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                if let url { urls.append(url) }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            editor.addFiles(urls)
        }
    }
}

/// One attachment card: media preview, name/size, caption field, and actions.
struct AttachmentCard: View {
    @EnvironmentObject var model: AppModel
    let attachment: EditorAttachment

    private var editor: EditorModel { model.editor }

    private var binding: Binding<EditorAttachment>? {
        guard editor.attachments.contains(where: { $0.id == attachment.id }) else { return nil }
        let id = attachment.id
        return Binding(
            get: { editor.attachments.first { $0.id == id } ?? attachment },
            set: { newValue in
                if let idx = editor.attachments.firstIndex(where: { $0.id == id }) {
                    editor.attachments[idx] = newValue
                }
            }
        )
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AttachmentPreview(attachment: attachment)
                .frame(width: 120, height: 90)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text("\(attachment.kind.rawValue) · \(EditorModel.humanSize(attachment.byteLength))")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let binding {
                    TextField("Caption (helps recall)", text: binding.caption)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.small)
                }

                HStack(spacing: 8) {
                    if case .existing = attachment.source {
                        Button("Find similar") {
                            Task { await model.findSimilar(to: attachment) }
                        }
                        .controlSize(.small)
                    }
                    Button("Remove", role: .destructive) {
                        editor.remove(attachment)
                    }
                    .controlSize(.small)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
        )
        .task(id: attachment.id) {
            await editor.loadPreviewData(for: attachment)
        }
    }
}

/// Renders an attachment's preview based on its kind. Fetches its own bytes
/// into local `@State` (lazily for existing attachments) so it re-renders once
/// the data lands, independent of the editor model's publishing.
struct AttachmentPreview: View {
    @EnvironmentObject var model: AppModel
    let attachment: EditorAttachment
    @State private var data: Data?

    var body: some View {
        Group {
            switch attachment.kind {
            case .image:
                if let data, let image = NSImage(data: data) {
                    Image(nsImage: image).resizable().scaledToFill()
                } else { placeholder("photo") }
            case .video:
                if let url = tempFileURL(data) {
                    MediaPlayerView(url: url)
                } else { placeholder("film") }
            case .audio:
                if let url = tempFileURL(data) {
                    MediaPlayerView(url: url)
                } else { placeholder("waveform") }
            case .pdf:
                if let data {
                    PDFThumbnail(data: data)
                } else { placeholder("doc.richtext") }
            }
        }
        .background(Color(nsColor: .controlColor))
        .task(id: attachment.id) { await loadData() }
    }

    private func loadData() async {
        if let inline = attachment.data { data = inline; return }
        guard case let .existing(attachmentId) = attachment.source,
              let memoryID = model.selectedID, let api = model.api else { return }
        if let bytes = try? await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentId) {
            data = bytes.data
        }
    }

    private func placeholder(_ symbol: String) -> some View {
        ZStack {
            Color(nsColor: .controlColor)
            Image(systemName: symbol).font(.title2).foregroundStyle(.secondary)
        }
    }

    /// Materialize bytes into a temp file so AVPlayer/QuickLook can read them.
    private func tempFileURL(_ data: Data?) -> URL? {
        guard let data else { return nil }
        let ext = UTType(mimeType: attachment.mimeType)?.preferredFilenameExtension ?? "bin"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("gemdex-\(attachment.id.uuidString)")
            .appendingPathExtension(ext)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? data.write(to: url)
        }
        return url
    }
}

/// AVKit player (AppKit) for audio + video previews, with standard controls.
struct MediaPlayerView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.player = AVPlayer(url: url)
        return view
    }
    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player == nil { nsView.player = AVPlayer(url: url) }
    }
}

/// Inline PDF preview using PDFKit.
struct PDFThumbnail: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePage
        view.document = PDFDocument(data: data)
        return view
    }
    func updateNSView(_ nsView: PDFView, context: Context) {
        if nsView.document == nil { nsView.document = PDFDocument(data: data) }
    }
}

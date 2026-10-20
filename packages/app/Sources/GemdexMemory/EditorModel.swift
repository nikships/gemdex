import Foundation
import SwiftUI

/// Editor state for one memory (new or existing). Besides content and title it
/// tracks attachment edits: files picked but not yet saved (`pending`), stored
/// attachments marked for removal, and caption edits on stored attachments.
@MainActor
final class EditorModel: ObservableObject {
    @Published var title: String = ""
    @Published var content: String = ""
    /// Attachments already stored on the memory being edited.
    @Published private(set) var attachments: [Attachment] = []
    @Published private(set) var pending: [PendingAttachment] = []
    @Published private(set) var removedIDs: Set<String> = []
    /// Caption edits on stored attachments, keyed by attachment id.
    @Published private(set) var captionDrafts: [String: String] = [:]
    @Published var isSaving = false
    @Published private(set) var saveProgress: String?
    @Published private(set) var saveError: String?
    /// Why the last picked file(s) were refused (unsupported type, PDF).
    @Published private(set) var attachNotice: String?

    /// nil while composing a brand-new memory.
    private(set) var memoryID: String?
    private(set) var createdAt: Double = 0
    private(set) var updatedAt: Double = 0

    weak var appModel: AppModel?

    var isEditingExisting: Bool { memoryID != nil }

    var metaText: String {
        guard isEditingExisting else { return "New memory" }
        return "Created \(Self.fmt(createdAt)) · Updated \(Self.fmt(updatedAt))"
    }

    /// Stored attachments that will survive the next save.
    var keptAttachments: [Attachment] { attachments.filter { !removedIDs.contains($0.id) } }

    /// True when the next save must replace the attachment list.
    var attachmentListChanged: Bool { !pending.isEmpty || !removedIDs.isEmpty }

    var hasAnyAttachment: Bool { !keptAttachments.isEmpty || !pending.isEmpty }

    func caption(for attachment: Attachment) -> String {
        captionDrafts[attachment.id] ?? attachment.caption ?? ""
    }

    // MARK: - Loading

    func startNew() {
        memoryID = nil
        title = ""
        content = ""
        attachments = []
        resetAttachmentEdits()
        createdAt = 0
        updatedAt = 0
    }

    func load(_ memory: Memory) {
        memoryID = memory.id
        title = memory.title
        content = memory.content
        createdAt = memory.createdAt
        updatedAt = memory.updatedAt
        attachments = memory.attachments
        resetAttachmentEdits()
    }

    private func resetAttachmentEdits() {
        pending = []
        removedIDs = []
        captionDrafts = [:]
        saveError = nil
        saveProgress = nil
        attachNotice = nil
    }

    // MARK: - Attachment edits

    func addPending(_ urls: [URL]) {
        var refused: [String] = []
        for url in urls {
            if let reason = MediaTypes.rejection(for: url) {
                refused.append(reason)
            } else if let mediaType = MediaTypes.lookup(url: url) {
                pending.append(PendingAttachment(url: url, mediaType: mediaType))
            }
        }
        attachNotice = refused.isEmpty ? nil : refused.joined(separator: "\n")
    }

    func removePending(_ id: UUID) { pending.removeAll { $0.id == id } }

    func setPendingCaption(_ id: UUID, _ caption: String) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].caption = caption
    }

    func markRemoved(_ id: String) { removedIDs.insert(id) }
    func undoRemoved(_ id: String) { removedIDs.remove(id) }

    func setCaptionDraft(_ id: String, _ caption: String) {
        captionDrafts[id] = caption
    }

    /// Stored attachments whose caption was edited (and not removed).
    private var changedCaptions: [(id: String, caption: String)] {
        keptAttachments.compactMap { attachment in
            guard let draft = captionDrafts[attachment.id] else { return nil }
            let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed == (attachment.caption ?? "") ? nil : (attachment.id, trimmed)
        }
    }

    // MARK: - Save

    func save() async {
        guard !isSaving, let appModel, let api = appModel.api else { return }
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedContent.isEmpty && !hasAnyAttachment {
            let message = "Add some content or an attachment before saving."
            saveError = message
            appModel.setStatus(message, isError: true)
            return
        }
        isSaving = true
        saveError = nil
        defer {
            isSaving = false
            saveProgress = nil
        }

        let titleArg = title.trimmingCharacters(in: .whitespaces)
        do {
            if let memoryID {
                let uploads: [AttachmentUpload]? = attachmentListChanged
                    ? try await buildUploads(memoryID: memoryID, api: api)
                    : nil
                saveProgress = pending.isEmpty ? "Saving…" : "Saving and embedding media — this can take a few seconds…"
                try await api.updateMemory(memoryID, content: content, title: titleArg, attachments: uploads)
                let captions = uploads == nil ? changedCaptions : []
                if !captions.isEmpty {
                    try await api.updateCaptions(memoryID, captions: captions)
                }
                await appModel.refreshList()
                await appModel.openMemory(memoryID)
            } else {
                let uploads = try await buildUploads(memoryID: nil, api: api)
                saveProgress = uploads.isEmpty ? "Saving…" : "Saving and embedding media — this can take a few seconds…"
                let created = try await api.createMemory(content: content, title: titleArg, attachments: uploads)
                await appModel.refreshList()
                await appModel.openMemory(created.id)
            }
            appModel.setStatus("Saved.")
        } catch {
            if appModel.handleNeedsInstall(error) { return }
            let message = (error as? APIError)?.message ?? error.localizedDescription
            saveError = message
            appModel.setStatus("Error: \(message)", isError: true)
        }
    }

    /// Full replacement list: kept stored attachments (bytes re-fetched, id and
    /// caption preserved) followed by the pending files.
    private func buildUploads(memoryID: String?, api: APIClient) async throws -> [AttachmentUpload] {
        let keptBytes = memoryID == nil ? 0 : keptAttachments.reduce(0) { $0 + $1.byteLength }
        let pendingBytes = pending.reduce(0) { total, file in
            total + ((try? file.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        if let problem = MediaTypes.requestSizeProblem(rawBytes: keptBytes + pendingBytes) {
            throw APIError(status: 413, message: problem)
        }
        var uploads: [AttachmentUpload] = []
        if let memoryID {
            for attachment in keptAttachments {
                saveProgress = "Reading \(attachment.suggestedFilename)…"
                let bytes = try await api.attachmentBytes(memoryId: memoryID, attachmentId: attachment.id)
                let data = bytes.data
                let encoded = await Task.detached(priority: .userInitiated) { data.base64EncodedString() }.value
                let trimmed = caption(for: attachment).trimmingCharacters(in: .whitespacesAndNewlines)
                uploads.append(AttachmentUpload(id: attachment.id, mimeType: attachment.mimeType, data: encoded, caption: trimmed))
            }
        }
        for file in pending {
            saveProgress = "Reading \(file.filename)…"
            let url = file.url
            let encoded: String
            do {
                encoded = try await Task.detached(priority: .userInitiated) {
                    try Data(contentsOf: url, options: .mappedIfSafe).base64EncodedString()
                }.value
            } catch {
                throw APIError(status: -1, message: "Couldn't read \(file.filename): \(error.localizedDescription)")
            }
            let trimmed = file.caption.trimmingCharacters(in: .whitespacesAndNewlines)
            uploads.append(AttachmentUpload(id: nil, mimeType: file.mediaType.mimeType, data: encoded, caption: trimmed))
        }
        return uploads
    }

    // MARK: - Formatting helpers

    /// Cached: sidebar rows call this on every render, and constructing a
    /// DateFormatter per call is expensive enough to stutter scrolling.
    /// Main-actor only, so the non-thread-safe formatter is fine.
    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    static func fmt(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        return dateFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func humanSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

import Foundation
import SwiftUI

/// Editor state for one memory (new or existing). Content and title are
/// editable; attachments are read-only and are never sent on save, so a PUT
/// leaves them untouched.
@MainActor
final class EditorModel: ObservableObject {
    @Published var title: String = ""
    @Published var content: String = ""
    @Published private(set) var attachments: [Attachment] = []
    @Published var isSaving = false

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

    // MARK: - Loading

    func startNew() {
        memoryID = nil
        title = ""
        content = ""
        attachments = []
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
    }

    // MARK: - Save

    func save() async {
        guard let appModel, let api = appModel.api else { return }
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedContent.isEmpty && attachments.isEmpty {
            appModel.setStatus("Add some content before saving.", isError: true)
            return
        }
        isSaving = true
        defer { isSaving = false }

        let titleArg = title.trimmingCharacters(in: .whitespaces)
        do {
            if let memoryID {
                try await api.updateMemory(memoryID, content: content, title: titleArg)
                await appModel.refreshList()
                await appModel.openMemory(memoryID)
            } else {
                let created = try await api.createMemory(content: content, title: titleArg)
                await appModel.refreshList()
                await appModel.openMemory(created.id)
            }
            appModel.setStatus("Saved.")
        } catch {
            if appModel.handleNeedsInstall(error) { return }
            let message = (error as? APIError)?.message ?? error.localizedDescription
            appModel.setStatus("Error: \(message)", isError: true)
        }
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

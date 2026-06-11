import Foundation

/// Media modalities `gemini-embedding-2` accepts. Mirrors `AttachmentKind` in
/// gemdex-core. The sidecar always sends one of these in `kind`, but we infer
/// from `mimeType` defensively when older payloads omit it.
enum AttachmentKind: String, Codable, Sendable {
    case image
    case audio
    case video
    case pdf

    static func from(mimeType: String) -> AttachmentKind? {
        let m = mimeType.lowercased()
        if m.hasPrefix("image/") { return .image }
        if m.hasPrefix("audio/") { return .audio }
        if m.hasPrefix("video/") { return .video }
        if m == "application/pdf" || m.hasSuffix("/pdf") { return .pdf }
        return nil
    }
}

/// Stored-attachment metadata as seen by the manager UI. Raw bytes are fetched
/// on demand from `GET /memories/:id/attachments/:attachmentId`.
struct Attachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: AttachmentKind
    let mimeType: String
    let byteLength: Int
    var caption: String?

    private enum CodingKeys: String, CodingKey {
        case id, kind, mimeType, byteLength, caption
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        mimeType = (try? c.decode(String.self, forKey: .mimeType)) ?? "application/octet-stream"
        byteLength = (try? c.decode(Int.self, forKey: .byteLength)) ?? 0
        caption = try? c.decode(String.self, forKey: .caption)
        if let raw = try? c.decode(String.self, forKey: .kind), let k = AttachmentKind(rawValue: raw) {
            kind = k
        } else {
            kind = AttachmentKind.from(mimeType: mimeType) ?? .image
        }
    }
}

/// Lightweight memory shape for the sidebar list (`GET /memories`).
struct MemorySummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let preview: String
    let attachments: [Attachment]
    let createdAt: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, title, preview, attachments, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        preview = (try? c.decode(String.self, forKey: .preview)) ?? ""
        attachments = (try? c.decode([Attachment].self, forKey: .attachments)) ?? []
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
    }

    var displayTitle: String { title.isEmpty ? "Untitled memory" : title }
    var firstImage: Attachment? { attachments.first { $0.kind == .image } }
}

/// A full memory (`GET /memories/:id`).
struct Memory: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let content: String
    let attachments: [Attachment]
    let createdAt: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, title, content, attachments, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        attachments = (try? c.decode([Attachment].self, forKey: .attachments)) ?? []
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
    }
}

/// A recall hit: full parent memory plus fused relevance score (`POST /recall`).
struct RecallResult: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let score: Double?

    private enum CodingKeys: String, CodingKey { case id, title, score }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        score = try? c.decode(Double.self, forKey: .score)
    }

    var displayTitle: String { title.isEmpty ? "Untitled memory" : title }
}

/// Active backend summary (`GET /config`).
struct ConfigSummary: Codable, Sendable {
    struct ActiveRemote: Codable, Sendable {
        let name: String
        let url: String?
        let hasToken: Bool?
    }
    let configured: Bool
    let mode: String
    let needsKey: Bool
    let activeRemote: ActiveRemote?
}

/// One configured remote (`GET /settings`).
struct RemoteSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String { name }
    let name: String
    let url: String
    let hasToken: Bool
}

/// Storage settings summary (`GET /settings`).
struct SettingsSummary: Codable, Sendable {
    let mode: String
    let activeRemote: String?
    let configured: Bool
    let localConfigured: Bool
    let remotes: [RemoteSummary]
}

/// Remote connection test result (`POST /settings/test`).
struct RemoteTestResult: Codable, Sendable {
    let reachable: Bool
    let authenticated: Bool
    let detail: String?
}

/// Local→remote import result (`POST /settings/import-local`).
struct MigrationResult: Codable, Sendable {
    let created: Int
    let updated: Int
    let skipped: Int
}

/// Import result (`POST /import`).
struct ImportResult: Codable, Sendable {
    let imported: Int
}

/// A portable export/import record (`GET /export`, `POST /import`). Attachments
/// are carried inline as base64 so a dump round-trips without the blob dir.
struct ExportRecord: Codable, Sendable {
    let id: String
    let title: String
    let content: String
    let createdAt: Double
    let updatedAt: Double
    let attachments: [ExportAttachment]?
}

struct ExportAttachment: Codable, Sendable {
    let id: String?
    let mimeType: String
    let data: String
    let caption: String?
}

// MARK: - Chat-history ingestion (`/ingest/*`)

/// One scannable session folder (`GET /ingest/sources` presets/customFolders).
struct IngestFolderSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String { path }
    let source: String
    let path: String
    let exists: Bool
    let sessionCount: Int
}

/// A selectable digest model with its standard-tier pricing.
struct IngestModelInfo: Codable, Identifiable, Hashable, Sendable {
    var id: String { model }
    let model: String
    let description: String
    let inputUsdPerMTok: Double
    let outputUsdPerMTok: Double
    let isDefault: Bool
}

/// `GET /ingest/sources` response.
struct IngestSources: Codable, Sendable {
    let presets: [IngestFolderSummary]
    let customFolders: [IngestFolderSummary]
    let models: [IngestModelInfo]
    let pricingAsOf: String
    let ingestReady: Bool
}

/// Per-model cost estimate (standard vs. Batch API pricing).
struct IngestCostEstimate: Codable, Identifiable, Hashable, Sendable {
    var id: String { model }
    let model: String
    let standardUsd: Double
    let batchUsd: Double
}

/// `POST /ingest/scan` response.
struct IngestScanSummary: Codable, Sendable {
    struct Buckets: Codable, Sendable {
        let newFiles: [IngestSessionFile]
        let changedFiles: [IngestSessionFile]
        let upToDate: [IngestSessionFile]
        let skippedActive: [IngestSessionFile]
    }
    let buckets: Buckets
    let pendingCount: Int
    let estimatedInputTokens: Int
    let estimatedOutputTokens: Int
    let estimates: [IngestCostEstimate]
}

struct IngestSessionFile: Codable, Hashable, Sendable {
    let source: String
    let filePath: String
}

/// `GET /ingest/status` response.
struct IngestStatus: Codable, Sendable {
    struct PendingBatch: Codable, Sendable {
        let jobName: String
        let model: String
        let submittedAt: Double
        let requestCount: Int
    }
    let state: String
    let processed: Int
    let failed: Int
    let skipped: Int
    let total: Int
    let currentFile: String?
    let error: String?
    let pendingBatch: PendingBatch?
}

/// `POST /ingest/collect` response.
struct IngestCollectResult: Codable, Sendable {
    let state: String
    let jobState: String?
    let ingested: Int?
    let failed: Int?
    let error: String?
}

/// Inline attachment payload for create/update (base64 `data`).
struct AttachmentInput: Codable, Sendable {
    let mimeType: String
    let data: String
    let caption: String?
}

/// Raw attachment bytes plus content type, for native rendering.
struct AttachmentBytes: Sendable {
    let data: Data
    let mimeType: String
}

import Foundation
import UniformTypeIdentifiers

/// Stored-attachment metadata as seen by the manager UI. Attachments are
/// read-only blobs (chat transcripts are `file` attachments with a text/plain
/// or application/x-ndjson mime type). `kind` is kept as the raw string so
/// legacy kinds (image/audio/video/pdf) and unknown future kinds still decode;
/// the UI treats every kind as a generic downloadable file. Raw bytes are
/// fetched on demand from `GET /memories/:id/attachments/:attachmentId`.
struct Attachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
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
        let raw = (try? c.decode(String.self, forKey: .kind))?.trimmingCharacters(in: .whitespaces) ?? ""
        kind = raw.isEmpty ? "file" : raw
    }

    /// File extension used when saving or opening the bytes locally.
    var fileExtension: String {
        switch mimeType.lowercased() {
        case "text/plain": return "txt"
        case "application/json": return "json"
        case "application/jsonl", "application/x-ndjson", "text/x-jsonl": return "jsonl"
        default: return UTType(mimeType: mimeType)?.preferredFilenameExtension ?? "bin"
        }
    }

    var isTranscript: Bool { fileExtension == "jsonl" }

    /// Suggested local filename. Attachments carry no stored name, so derive a
    /// stable one from the kind and id.
    var suggestedFilename: String {
        let base = isTranscript ? "transcript" : (kind == "file" ? "attachment" : kind)
        return "\(base)-\(id.prefix(8)).\(fileExtension)"
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
    let displayTitle: String
    let searchTitle: String
    let updatedLabel: String

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
        displayTitle = title.isEmpty ? "Untitled memory" : title
        searchTitle = displayTitle.lowercased()
        updatedLabel = Self.formatDate(updatedAt)
    }

    /// Precomputed once during JSON decoding. Sidebar rows reuse this while
    /// scrolling instead of formatting dates during every body recomputation.
    nonisolated private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    nonisolated private static func formatDate(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        return dateFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
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

/// Readiness of the user's local Claude Code CLI, which runs chat-history
/// digestion and hygiene judging (`claude -p`, Haiku). Status is one of
/// `checking | ready | missing | unauthenticated | error`.
struct ClaudeCodeReadiness: Codable, Equatable, Sendable {
    let status: String
    var message: String? = nil
    var version: String? = nil
    var path: String? = nil
    var checkedAt: Double? = nil

    var isReady: Bool { status == "ready" }
    var isChecking: Bool { status == "checking" }
}

/// Local embedding model (BGE-M3 via MLX) and its explicit install/migrate job
/// snapshot. Status is one of
/// `not-installed | installed | installing | migrating | error`.
struct EmbeddingStatus: Codable, Equatable, Sendable {
    let installed: Bool
    let model: String
    let status: String
    let message: String?
    let completed: Int?
    let total: Int?
    /// Memories still in the legacy Gemini index that need re-embedding.
    /// Present once the model is installed.
    var legacyMemories: Int? = nil

    var isRunning: Bool { status == "installing" || status == "migrating" }
}

/// Store and inference readiness (`GET /config`, `POST /config/check`).
/// `configured` means the local model is installed and the store is mounted.
struct ConfigSummary: Codable, Sendable {
    let configured: Bool
    var embedding: EmbeddingStatus
    var claudeCode: ClaudeCodeReadiness
}

/// One record that failed to import (`POST /import`).
struct ImportFailure: Codable, Sendable {
    let index: Int
    let id: String?
    let error: String
}

/// Import result (`POST /import`). `failed`/`errors` are optional so older
/// sidecars that return only `imported` still decode.
struct ImportResult: Codable, Sendable {
    let imported: Int
    let failed: Int?
    let errors: [ImportFailure]?
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

/// A digest/judge model with its API list pricing (used only for the
/// list-price estimate; Claude subscription logins are not billed per token).
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
    let claudeCode: ClaudeCodeReadiness
}

/// Per-model cost estimate at API list price.
struct IngestCostEstimate: Codable, Identifiable, Hashable, Sendable {
    var id: String { model }
    let model: String
    let usd: Double
}

/// Pending count and cost estimates for one ingestion scope.
struct IngestScanTotals: Codable, Sendable {
    let pendingCount: Int
    let estimatedInputTokens: Int
    let estimatedOutputTokens: Int
    let estimates: [IngestCostEstimate]
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

/// `GET /ingest/status` response. `state` is
/// `idle | running | done | failed | cancelled`.
struct IngestStatus: Codable, Sendable {
    let state: String
    let processed: Int
    let failed: Int
    let skipped: Int
    let total: Int
    let currentFile: String?
    let error: String?
}

// MARK: - Memory hygiene (`/hygiene/*`)

/// One memory inside a hygiene candidate cluster.
struct HygieneClusterMember: Codable, Identifiable, Hashable, Sendable {
    var id: String { memoryId }
    let memoryId: String
    let title: String
    let createdAt: Double
    let updatedAt: Double
    let contentLength: Int

    var displayTitle: String { title.isEmpty ? "Untitled memory" : title }
}

/// The LLM judge's per-memory verdict within a cluster.
struct HygieneFinding: Codable, Hashable, Sendable {
    let memoryId: String
    let verdict: String
    let supersededBy: String?
    let evidence: String?
    let confidence: String?

    var isKeep: Bool { verdict == "keep" }
    var isHighConfidence: Bool { confidence == "high" }
    /// Only high-confidence duplicate/superseded memories are ever pre-checked
    /// for deletion; contradicted and low/medium confidence stay unchecked.
    var isSafePreselect: Bool { isHighConfidence && (verdict == "duplicate" || verdict == "superseded") }
}

/// A cluster of similar memories. `findings`/`error` appear only after an
/// analysis run has judged the cluster.
struct HygieneCluster: Codable, Identifiable, Hashable, Sendable {
    var id: String { clusterId }
    let clusterId: String
    let similarity: Double
    let members: [HygieneClusterMember]
    let findings: [HygieneFinding]?
    let error: String?

    func finding(for memoryId: String) -> HygieneFinding? {
        findings?.first { $0.memoryId == memoryId }
    }

    var newestMember: HygieneClusterMember? {
        members.max { $0.updatedAt < $1.updatedAt }
    }
}

/// `POST /hygiene/scan` response: candidate clusters + LLM cost estimates.
struct HygieneScanSummary: Codable, Sendable {
    let scannedAt: Double
    let threshold: Double
    let memoryCount: Int
    let clusters: [HygieneCluster]
    let dismissedCount: Int
    let estimatedInputTokens: Int
    let estimatedOutputTokens: Int
    let estimates: [IngestCostEstimate]
}

/// Persisted hygiene report (`GET /hygiene/report`).
struct HygieneReport: Codable, Sendable {
    let version: Int
    let scannedAt: Double
    let judgedAt: Double?
    let model: String?
    let threshold: Double
    let memoryCount: Int
    let clusters: [HygieneCluster]
    let deletedIds: [String]
}

/// `GET /hygiene/status` response.
struct HygieneStatus: Codable, Sendable {
    let state: String
    let judged: Int
    let failed: Int
    let total: Int
    let error: String?
}

/// `GET /hygiene/report` envelope: last report (if any) plus judge models.
struct HygieneReportEnvelope: Codable, Sendable {
    let report: HygieneReport?
    let models: [IngestModelInfo]
    let pricingAsOf: String
    let hygieneReady: Bool
}

/// Raw attachment bytes plus content type, for open/save.
struct AttachmentBytes: Sendable {
    let data: Data
    let mimeType: String
}

import Foundation

/// File types the local sidecar accepts as attachments. The sidecar is the
/// authority (it answers 400 for anything else); this table only filters the
/// open panels and labels pending files. PDF is not supported locally.
enum MediaKind: String, Sendable {
    case image, audio, video, file

    var systemImage: String {
        switch self {
        case .image: return "photo"
        case .audio: return "waveform"
        case .video: return "film"
        case .file: return "doc.text"
        }
    }
}

struct MediaType: Sendable {
    let mimeType: String
    let kind: MediaKind
    let extensions: [String]
}

enum MediaTypes {
    static let all: [MediaType] = [
        MediaType(mimeType: "image/png", kind: .image, extensions: ["png"]),
        MediaType(mimeType: "image/jpeg", kind: .image, extensions: ["jpg", "jpeg"]),
        MediaType(mimeType: "image/webp", kind: .image, extensions: ["webp"]),
        MediaType(mimeType: "image/gif", kind: .image, extensions: ["gif"]),
        MediaType(mimeType: "audio/mpeg", kind: .audio, extensions: ["mp3"]),
        MediaType(mimeType: "audio/wav", kind: .audio, extensions: ["wav"]),
        MediaType(mimeType: "audio/flac", kind: .audio, extensions: ["flac"]),
        MediaType(mimeType: "audio/mp4", kind: .audio, extensions: ["m4a"]),
        MediaType(mimeType: "audio/aac", kind: .audio, extensions: ["aac"]),
        MediaType(mimeType: "audio/aiff", kind: .audio, extensions: ["aiff", "aif"]),
        MediaType(mimeType: "video/mp4", kind: .video, extensions: ["mp4"]),
        MediaType(mimeType: "video/quicktime", kind: .video, extensions: ["mov"]),
        MediaType(mimeType: "video/x-m4v", kind: .video, extensions: ["m4v"]),
        MediaType(mimeType: "video/webm", kind: .video, extensions: ["webm"]),
        MediaType(mimeType: "text/plain", kind: .file, extensions: ["txt"]),
        MediaType(mimeType: "application/json", kind: .file, extensions: ["json"]),
        MediaType(mimeType: "application/x-ndjson", kind: .file, extensions: ["jsonl", "ndjson"]),
    ]

    /// Extensions for the editor's Attach… panel (embedded media + stored files).
    static var attachableExtensions: [String] { all.flatMap(\.extensions) }

    /// Extensions for Search by file… (only media is embedded as a query).
    static var searchableExtensions: [String] {
        all.filter { $0.kind != .file }.flatMap(\.extensions)
    }

    static func lookup(extension ext: String) -> MediaType? {
        let lower = ext.lowercased()
        return all.first { $0.extensions.contains(lower) }
    }

    static func lookup(url: URL) -> MediaType? { lookup(extension: url.pathExtension) }

    /// Mirrors the sidecar's per-memory and per-file limits as a UI hint only.
    static let limitsHint =
        "Up to 8 images, 4 audio, 2 video and 4 text/JSON files per memory · 100 MiB each · audio up to 5 minutes."
}

/// A file picked in the editor that has not been saved yet. Bytes are read
/// from disk at save time so a large video never sits in memory while editing.
struct PendingAttachment: Identifiable, Equatable, Sendable {
    let id = UUID()
    let url: URL
    let mediaType: MediaType
    var caption: String = ""

    var filename: String { url.lastPathComponent }

    static func == (lhs: PendingAttachment, rhs: PendingAttachment) -> Bool { lhs.id == rhs.id && lhs.caption == rhs.caption }
}

/// A media file chosen as the query for `POST /recall` (search by example).
struct SearchFile: Equatable, Sendable {
    let url: URL
    let mediaType: MediaType

    var filename: String { url.lastPathComponent }

    static func == (lhs: SearchFile, rhs: SearchFile) -> Bool { lhs.url == rhs.url }
}

/// Wire shape for one attachment sent to the sidecar. `data` is base64.
struct AttachmentUpload: Sendable {
    var id: String?
    let mimeType: String
    let data: String
    var caption: String?

    var json: [String: Any] {
        var obj: [String: Any] = ["mimeType": mimeType, "data": data]
        if let id { obj["id"] = id }
        if let caption, !caption.isEmpty { obj["caption"] = caption }
        return obj
    }
}

import AppKit
import Foundation
import ImageIO

/// Fetches, downsamples, and caches sidebar thumbnails so scrolling never
/// re-fetches or re-decodes full-size attachments. Rows render synchronously
/// from the cache when possible; misses fetch once (coalescing concurrent
/// requests for the same attachment) and decode off the main actor via
/// ImageIO thumbnailing — the full image is never decoded.
@MainActor
final class ThumbnailLoader: ObservableObject {
    /// 46pt row thumbnail at 2x.
    static let maxPixelSize = 92

    /// NSImage's Sendable conformance needs macOS 14 and we deploy to 13; the
    /// image is created on a background task and handed off without further
    /// mutation, so an unchecked box is safe.
    private struct ImageBox: @unchecked Sendable { let image: NSImage? }

    private let cache = NSCache<NSString, NSImage>()
    private var inFlight: [String: Task<ImageBox, Never>] = [:]

    weak var appModel: AppModel?

    init() {
        cache.countLimit = 500
    }

    private static func key(memoryID: String, attachmentID: String) -> String {
        "\(memoryID)/\(attachmentID)"
    }

    /// Synchronous cache lookup so a recycled row can render its thumbnail
    /// immediately without a placeholder flash.
    func cached(memoryID: String, attachmentID: String) -> NSImage? {
        cache.object(forKey: Self.key(memoryID: memoryID, attachmentID: attachmentID) as NSString)
    }

    /// Fetch + downsample, coalescing concurrent requests for the same
    /// attachment. Returns nil on any failure (the row keeps its placeholder).
    func thumbnail(memoryID: String, attachmentID: String) async -> NSImage? {
        let key = Self.key(memoryID: memoryID, attachmentID: attachmentID)
        if let hit = cache.object(forKey: key as NSString) { return hit }
        if let pending = inFlight[key] { return await pending.value.image }

        guard let api = appModel?.api else { return nil }
        let task = Task<ImageBox, Never> {
            guard let bytes = try? await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentID) else {
                return ImageBox(image: nil)
            }
            return await Self.downsample(bytes.data, maxPixelSize: Self.maxPixelSize)
        }
        inFlight[key] = task
        let image = await task.value.image
        inFlight[key] = nil
        if let image {
            cache.setObject(image, forKey: key as NSString)
        }
        return image
    }

    /// ImageIO thumbnailing on a background task: decodes only a small bitmap,
    /// never the full image.
    nonisolated private static func downsample(_ data: Data, maxPixelSize: Int) async -> ImageBox {
        await Task.detached(priority: .userInitiated) {
            let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
            guard let source = CGImageSourceCreateWithData(data as CFData, options as CFDictionary) else {
                return ImageBox(image: nil)
            }
            let thumbOptions: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else {
                return ImageBox(image: nil)
            }
            return ImageBox(image: NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height)))
        }.value
    }
}

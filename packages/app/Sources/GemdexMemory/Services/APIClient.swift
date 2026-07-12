import Foundation

/// Error surfaced by the sidecar (carries the server's `error` message and any
/// `needsKey` flag from the 503 not-configured response).
struct APIError: LocalizedError {
    let status: Int
    let message: String
    let needsKey: Bool
    var errorDescription: String? { message }
}

/// Thin async HTTP client for the localhost `gemdex serve` sidecar.
///
/// The base URL + per-launch token come from the sidecar handshake
/// (`PORT=<n> TOKEN=<hex>`). Every data route carries `X-Gemdex-Token`; the
/// sidecar rejects requests without it. We never set an `Origin` header — the
/// serve layer treats an absent Origin as a same-process caller and allows it.
actor APIClient {
    private var baseURL: URL
    private var token: String
    private let session: URLSession

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config)
    }

    func update(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    var currentBaseURL: URL { baseURL }
    var currentToken: String { token }

    // MARK: - Core request plumbing

    private func makeRequest(_ method: String, _ path: String, body: Data? = nil) -> URLRequest {
        request(method, path: path, body: body)
    }

    /// Build a request against an exact path (preserving slashes/segments).
    private func request(_ method: String, path: String, body: Data? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = (components.path as NSString).appendingPathComponent(path)
        var req = URLRequest(url: components.url!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { req.setValue(token, forHTTPHeaderField: "X-Gemdex-Token") }
        req.httpBody = body
        return req
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: -1, message: "No HTTP response", needsKey: false)
        }
        if !(200...299).contains(http.statusCode) {
            var message = "HTTP \(http.statusCode)"
            var needsKey = false
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let e = obj["error"] as? String { message = e }
                if let nk = obj["needsKey"] as? Bool { needsKey = nk }
            }
            throw APIError(status: http.statusCode, message: message, needsKey: needsKey)
        }
        return (data, http)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(status: -1, message: "Malformed response: \(error.localizedDescription)", needsKey: false)
        }
    }

    // MARK: - Health & config

    func health() async -> Bool {
        guard let (data, http) = try? await send(makeRequest("GET", "/health")) else { return false }
        guard http.statusCode == 200, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return (obj["ok"] as? Bool) == true
    }

    func config() async throws -> ConfigSummary {
        let (data, _) = try await send(makeRequest("GET", "/config"))
        return try decode(ConfigSummary.self, from: data)
    }

    @discardableResult
    func setApiKey(_ key: String) async throws -> ConfigSummary {
        let body = try JSONSerialization.data(withJSONObject: ["apiKey": key])
        let (data, _) = try await send(makeRequest("POST", "/config", body: body))
        return try decode(ConfigSummary.self, from: data)
    }

    @discardableResult
    func validateConfiguredApiKey() async throws -> ConfigSummary {
        // 200 = valid; 503 = still locked. Both include a ConfigSummary so the
        // UI can refresh readiness without a follow-up GET /config.
        let req = makeRequest("POST", "/config/validate")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: -1, message: "No HTTP response", needsKey: false)
        }
        if http.statusCode == 200 || http.statusCode == 503 {
            return try decode(ConfigSummary.self, from: data)
        }
        var message = "HTTP \(http.statusCode)"
        var needsKey = false
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let e = obj["error"] as? String { message = e }
            if let nk = obj["needsKey"] as? Bool { needsKey = nk }
        }
        throw APIError(status: http.statusCode, message: message, needsKey: needsKey)
    }

    // MARK: - Memories

    func listMemories() async throws -> [MemorySummary] {
        let (data, _) = try await send(makeRequest("GET", "/memories"))
        struct Wrapper: Decodable { let memories: [MemorySummary] }
        return try decode(Wrapper.self, from: data).memories
    }

    func getMemory(_ id: String) async throws -> Memory {
        let (data, _) = try await send(request("GET", path: "/memories/\(id)"))
        struct Wrapper: Decodable { let memory: Memory }
        return try decode(Wrapper.self, from: data).memory
    }

    @discardableResult
    func createMemory(content: String, title: String?, attachments: [AttachmentInput]?) async throws -> Memory {
        var payload: [String: Any] = ["content": content]
        if let title, !title.isEmpty { payload["title"] = title }
        if let attachments { payload["attachments"] = attachments.map(encodeAttachment) }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await send(makeRequest("POST", "/memories", body: body))
        struct Wrapper: Decodable { let memory: Memory }
        return try decode(Wrapper.self, from: data).memory
    }

    @discardableResult
    func updateMemory(_ id: String, content: String, title: String?, attachments: [AttachmentInput]?) async throws -> Memory {
        var payload: [String: Any] = ["content": content, "title": titleValue(title)]
        if let attachments { payload["attachments"] = attachments.map(encodeAttachment) }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await send(request("PUT", path: "/memories/\(id)", body: body))
        struct Wrapper: Decodable { let memory: Memory }
        return try decode(Wrapper.self, from: data).memory
    }

    /// Caption-only edit: PUT content/title (no attachments) then PATCH captions
    /// so existing media isn't re-fetched and re-embedded.
    func updateContentOnly(_ id: String, content: String, title: String?) async throws {
        let payload: [String: Any] = ["content": content, "title": titleValue(title)]
        let body = try JSONSerialization.data(withJSONObject: payload)
        _ = try await send(request("PUT", path: "/memories/\(id)", body: body))
    }

    func updateCaptions(_ id: String, captions: [(id: String, caption: String?)]) async throws {
        let captionPayload: [[String: Any]] = captions.map { entry in
            var item: [String: Any] = ["id": entry.id]
            item["caption"] = entry.caption ?? ""
            return item
        }
        let body = try JSONSerialization.data(withJSONObject: ["captions": captionPayload])
        _ = try await send(request("PATCH", path: "/memories/\(id)/attachments", body: body))
    }

    func deleteMemory(_ id: String) async throws {
        _ = try await send(request("DELETE", path: "/memories/\(id)"))
    }

    // MARK: - Attachments

    func attachmentBytes(memoryId: String, attachmentId: String) async throws -> AttachmentBytes {
        let (data, http) = try await send(request("GET", path: "/memories/\(memoryId)/attachments/\(attachmentId)"))
        let mime = http.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        return AttachmentBytes(data: data, mimeType: mime)
    }

    // MARK: - Recall

    /// Semantic free-text recall: the sidecar embeds the query and returns the
    /// parent-document hybrid (dense + BM25 + RRF) ranking, whole parents.
    func recallByText(query: String, limit: Int = 50) async throws -> [RecallResult] {
        let payload: [String: Any] = ["query": query, "limit": limit]
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await send(makeRequest("POST", "/recall", body: body))
        struct Wrapper: Decodable { let results: [RecallResult] }
        return try decode(Wrapper.self, from: data).results
    }

    // MARK: - Export / import

    func exportAll() async throws -> [ExportRecord] {
        let (data, _) = try await send(makeRequest("GET", "/export"))
        struct Wrapper: Decodable { let records: [ExportRecord] }
        return try decode(Wrapper.self, from: data).records
    }

    @discardableResult
    func importRecords(_ jsonData: Data) async throws -> ImportResult {
        // jsonData is the raw `{ "records": [...] }` payload built by the caller.
        let (data, _) = try await send(makeRequest("POST", "/import", body: jsonData))
        return try decode(ImportResult.self, from: data)
    }

    // MARK: - Settings

    func settings() async throws -> SettingsSummary {
        let (data, _) = try await send(makeRequest("GET", "/settings"))
        return try decode(SettingsSummary.self, from: data)
    }

    @discardableResult
    func setMode(_ mode: String, name: String? = nil) async throws -> SettingsSummary {
        var payload: [String: Any] = ["mode": mode]
        if let name { payload["name"] = name }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await send(makeRequest("POST", "/settings/mode", body: body))
        return try decode(SettingsSummary.self, from: data)
    }

    @discardableResult
    func saveRemote(name: String, url: String, token: String?) async throws -> SettingsSummary {
        var payload: [String: Any] = ["name": name, "url": url]
        if let token, !token.isEmpty { payload["token"] = token }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await send(makeRequest("POST", "/settings/remotes", body: body))
        return try decode(SettingsSummary.self, from: data)
    }

    @discardableResult
    func removeRemote(_ name: String) async throws -> SettingsSummary {
        let (data, _) = try await send(request("DELETE", path: "/settings/remotes/\(name)"))
        return try decode(SettingsSummary.self, from: data)
    }

    func testRemote(_ name: String) async throws -> RemoteTestResult {
        let body = try JSONSerialization.data(withJSONObject: ["name": name])
        let (data, _) = try await send(makeRequest("POST", "/settings/test", body: body))
        return try decode(RemoteTestResult.self, from: data)
    }

    func importLocalToRemote(_ name: String) async throws -> MigrationResult {
        let body = try JSONSerialization.data(withJSONObject: ["name": name])
        let (data, _) = try await send(makeRequest("POST", "/settings/import-local", body: body))
        return try decode(MigrationResult.self, from: data)
    }

    // MARK: - Chat-history ingestion

    func ingestSources() async throws -> IngestSources {
        let (data, _) = try await send(makeRequest("GET", "/ingest/sources"))
        return try decode(IngestSources.self, from: data)
    }

    @discardableResult
    func addIngestFolder(_ path: String) async throws -> IngestSources {
        let body = try JSONSerialization.data(withJSONObject: ["path": path])
        let (data, _) = try await send(makeRequest("POST", "/ingest/folders", body: body))
        return try decode(IngestSources.self, from: data)
    }

    @discardableResult
    func removeIngestFolder(_ path: String) async throws -> IngestSources {
        let body = try JSONSerialization.data(withJSONObject: ["path": path])
        let (data, _) = try await send(makeRequest("DELETE", "/ingest/folders", body: body))
        return try decode(IngestSources.self, from: data)
    }

    /// `sources` is a list of `{source: claude|factory|codex|antigravity|custom, path?}` entries.
    func ingestScan(sources: [[String: Any]]) async throws -> IngestScanSummary {
        let body = try JSONSerialization.data(withJSONObject: ["sources": sources])
        let (data, _) = try await send(makeRequest("POST", "/ingest/scan", body: body))
        return try decode(IngestScanSummary.self, from: data)
    }

    func ingestStart(sources: [[String: Any]], model: String, mode: String) async throws {
        let payload: [String: Any] = ["sources": sources, "model": model, "mode": mode]
        let body = try JSONSerialization.data(withJSONObject: payload)
        _ = try await send(makeRequest("POST", "/ingest/start", body: body))
    }

    func ingestStatus() async throws -> IngestStatus {
        let (data, _) = try await send(makeRequest("GET", "/ingest/status"))
        return try decode(IngestStatus.self, from: data)
    }

    func ingestCollect() async throws -> IngestCollectResult {
        let (data, _) = try await send(makeRequest("POST", "/ingest/collect"))
        return try decode(IngestCollectResult.self, from: data)
    }

    func ingestCancel() async throws {
        _ = try await send(makeRequest("POST", "/ingest/cancel"))
    }

    // MARK: - Helpers

    private func encodeAttachment(_ a: AttachmentInput) -> [String: Any] {
        var item: [String: Any] = ["mimeType": a.mimeType, "data": a.data]
        if let caption = a.caption, !caption.isEmpty { item["caption"] = caption }
        return item
    }

    /// A non-empty title encodes as a string; an empty/nil title clears it.
    private func titleValue(_ title: String?) -> Any {
        guard let title, !title.isEmpty else { return NSNull() }
        return title
    }
}

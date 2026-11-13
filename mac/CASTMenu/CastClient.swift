// Talks to the CAST server over loopback HTTP:
//   GET  /api/version     (no sign-in) is anyone there, and is it CAST, and which data folder (instanceId)?
//   POST /api/pair        trades the pairing token (<dataDir>/token) for a device session of this app's own; the
//                         cookie is kept in <dataDir>/menubar-session (0600)
//   GET  /api/status      what the menu shows
//   POST /api/login-link  a one-time sign-in link for a browser on this Mac
// The URLSession is ephemeral and never stores cookies: the session cookie is set by hand on each request, and is
// never logged or shown.
import Foundation

struct VersionInfo {
    let version: String
    let features: [String]
    /// Random per data folder (<dataDir>/instance-id): tells whether a running CAST uses this app's data.
    let instanceId: String?
}

/// What holds a port.
enum Probe {
    case cast(VersionInfo)
    case busy
    case free
}

enum ClientError: Error, Equatable {
    case noServer, unreachable, noToken, badToken, rateLimited, waitingToPair, badReply
    case http(Int)

    /// A few words for the menu's status line.
    var menuText: String {
        switch self {
        case .noServer, .unreachable: return "Can't reach CAST"
        case .noToken: return "Can't sign in: CAST's pairing token is missing"
        case .badToken: return "Can't sign in: this CAST uses another data folder"
        case .rateLimited: return "Can't sign in yet: too many tries, waiting"
        case .waitingToPair: return "Not signed in to CAST yet, trying again soon"
        case .badReply: return "CAST sent an answer this app doesn't understand"
        case .http(404): return "This CAST is too old for the menu-bar app"
        case .http(let code): return "CAST answered with an error (\(code))"
        }
    }
}

/// GET /api/status, read leniently: a missing or odd field is a zero, never a failure.
struct CastStatus {
    struct Attention {
        let kind: String
        let house: String
        let person: String
        let title: String
        /// The house's id for a #/house/<id> link, when the server sends one.
        let houseId: String?
        /// The same-origin path that opens CAST at this item (the server's `next`, e.g. /#/house/<id>/<job>), when
        /// it sends one; it is passed to /api/login-link as is.
        let next: String?
        /// The same waiting item keeps the same key, so it is announced once: the server's stable `id` when it sends
        /// one (an error's text may change while it waits), else the item's fields.
        let key: String

        var menuTitle: String {
            let what: String
            switch kind {
            case "approval": what = "Approval"
            case "question": what = "Question"
            case "error": what = "Problem"
            default: what = "Needs you"
            }
            let who = [person, house].filter { !$0.isEmpty }.joined(separator: " in ")
            let about = title.isEmpty ? "" : ": " + title
            return clip("\(what) — \(who)\(about)", 80)
        }
    }

    var version = ""
    var cityName = ""
    var total = 0
    var working = 0
    var needsYou = 0
    var approvalsWaiting = 0
    var runsActive = 0
    var houses = 0
    var ompState = "ok"
    var ompVersion: String?
    var modelsConnected = 0
    /// The AI-account check: "checking", "ok", "stale" or "failed" (an older server doesn't say: "ok").
    var modelsState = "ok"
    var attention: [Attention] = []

    init(json o: [String: Any]) {
        func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }
        func str(_ v: Any?) -> String { (v as? String) ?? (v as? NSNumber)?.stringValue ?? "" }
        version = str(o["version"])
        cityName = str(o["cityName"])
        let agents = o["agents"] as? [String: Any] ?? [:]
        total = int(agents["total"])
        working = int(agents["working"])
        needsYou = int(agents["needsYou"])
        approvalsWaiting = int(o["approvalsWaiting"])
        runsActive = int(o["runsActive"])
        houses = (o["houses"] as? [Any])?.count ?? int(o["houses"])
        let omp = o["omp"] as? [String: Any] ?? [:]
        ompState = omp["state"] as? String ?? "ok"
        ompVersion = omp["version"] as? String
        let models = o["models"] as? [String: Any] ?? [:]
        modelsConnected = int(models["connected"])
        modelsState = models["state"] as? String ?? "ok"
        let items = o["attention"] as? [[String: Any]] ?? []
        attention = items.prefix(10).map { (a: [String: Any]) -> Attention in
            let kind = str(a["kind"]), house = str(a["house"]), person = str(a["person"]), title = str(a["title"])
            let id = (a["houseId"] as? String) ?? (a["projectId"] as? String)
            let next = (a["next"] as? String).flatMap { CastStatus.isLocalPath($0) ? $0 : nil }
            let stable = str(a["id"])
            let key = stable.isEmpty ? [kind, house, person, title, str(a["since"])].joined(separator: "\u{1F}") : stable
            return Attention(kind: kind, house: house, person: person, title: title, houseId: id, next: next, key: key)
        }
    }

    /// A path on the same server ("/…", not "//host"), short and without spaces or control characters: what
    /// /api/login-link accepts as `next`.
    static func isLocalPath(_ text: String) -> Bool {
        text.count <= 2048 && text.hasPrefix("/") && !text.hasPrefix("//") && !text.contains("\\")
            && text.unicodeScalars.allSatisfy { $0.value > 0x20 && $0.value != 0x7F }
    }

    /// People waiting on the user (approvals and questions): the number on the menu-bar badge.
    var waitingCount: Int { max(needsYou, approvalsWaiting) }

    /// Nobody can work: the agent is fine and a check of the AI accounts worked, but none is connected (the page's
    /// "Connect AI"). Not while the agent has a problem or a check runs or failed: those say so themselves.
    var needsAccount: Bool { ompState == "ok" && (modelsState == "ok" || modelsState == "stale") && modelsConnected == 0 }
}

@MainActor
final class CastClient {
    static let deviceName = "CAST menu bar (Mac)"

    private let paths: Paths
    private let session: URLSession
    /// The port of the server in use; ServerController sets it once the server answers. A server that has just
    /// (re)started may have a new pairing token ("Delete all CAST data" makes one), so it may be paired with at once.
    var port: Int? {
        didSet { if port != nil, port != oldValue { lastPairAttempt = nil } }
    }
    private var cookie: String?
    /// When the server last answered a pairing request: it is asked again at most once a minute.
    private var lastPairAttempt: Date?
    /// The pairing in flight. The status poll and "Open CAST" may both need a session at the same moment (the very
    /// first start does exactly that); they share one pairing instead of the second one failing as "too soon".
    private var pairing: Task<Void, Error>?

    init(paths: Paths) {
        self.paths = paths
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 15
        config.connectionProxyDictionary = [:] // loopback only: never through a proxy
        session = URLSession(configuration: config)
    }

    private func endpoint(_ port: Int, _ path: String) -> URL {
        URL(string: "http://127.0.0.1:\(port)\(path)")!
    }

    private static func parseVersion(_ data: Data, _ response: URLResponse) -> VersionInfo? {
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              obj["app"] as? String == "cast" else { return nil }
        return VersionInfo(version: obj["version"] as? String ?? "?",
                           features: obj["features"] as? [String] ?? [],
                           instanceId: obj["instanceId"] as? String)
    }

    /// GET /api/version; nil unless CAST answers.
    func version(port: Int) async -> VersionInfo? {
        var request = URLRequest(url: endpoint(port, "/api/version"), timeoutInterval: 2)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let reply = try? await session.data(for: request) else { return nil }
        return Self.parseVersion(reply.0, reply.1)
    }

    /// Who holds this port: CAST, something else (it answered, or it can't be bound), or nobody.
    func probe(port: Int) async -> Probe {
        var request = URLRequest(url: endpoint(port, "/api/version"), timeoutInterval: 2)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            if let info = Self.parseVersion(data, response) { return .cast(info) }
            return .busy
        } catch {
            return canBindLoopback(port) ? .free : .busy
        }
    }

    /// Makes sure there is a session: the saved one, else a new pairing.
    func signIn() async throws {
        guard let port else { throw ClientError.noServer }
        if cookie == nil, pairing == nil, let saved = readTrimmed(paths.sessionFile), Self.isCookie(saved) { cookie = saved }
        if cookie == nil { try await pair(port: port) }
    }

    /// GET /api/status
    func status() async throws -> CastStatus {
        let obj = try await call("GET", "/api/status")
        return CastStatus(json: obj)
    }

    /// POST /api/login-link: a one-time sign-in link for a browser on this Mac that lands on `next`
    /// (a path such as /?settings=pair). The link is opened, never shown or logged.
    func loginLink(next: String?) async throws -> URL {
        var body: [String: Any] = [:]
        if let next { body["next"] = next }
        let obj = try await call("POST", "/api/login-link", body: body)
        guard let text = obj["url"] as? String, let url = URL(string: text),
              url.scheme == "http" || url.scheme == "https" else { throw ClientError.badReply }
        return url
    }

    /// An authenticated JSON call. Pairs first when there is no session, and pairs again after a 401/403
    /// (at most once a minute).
    private func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        try await signIn()
        guard let port else { throw ClientError.noServer }
        let used = cookie
        var (status, data) = try await send(method, port, path, body)
        if status == 401 || status == 403 {
            // Signed out. Unless another call has paired again meanwhile (then its new session is simply used).
            if cookie == nil || cookie == used { try await pair(port: port) }
            (status, data) = try await send(method, port, path, body)
        }
        guard (200..<300).contains(status) else { throw ClientError.http(status) }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw ClientError.badReply }
        return obj
    }

    /// Pairs once at a time: a caller that comes while a pairing runs waits for that one.
    private func pair(port: Int) async throws {
        if let running = pairing {
            try await running.value
            return
        }
        if let last = lastPairAttempt, Date().timeIntervalSince(last) < 60 { throw ClientError.waitingToPair }
        let task = Task { try await self.pairNow(port: port) }
        pairing = task
        defer { pairing = nil }
        try await task.value
    }

    private func pairNow(port: Int) async throws {
        cookie = nil
        guard let token = readTrimmed(paths.tokenFile) else { throw ClientError.noToken }
        let body: [String: Any] = ["token": token, "device": Self.deviceName, "kind": "app"]
        // Only a request the server answered counts for the once-a-minute limit: a server that is not up yet
        // (connection refused) is simply asked again on the next poll.
        let (status, data) = try await send("POST", port, "/api/pair", body, signedIn: false)
        lastPairAttempt = Date()
        switch status {
        case 200: break
        case 403: throw ClientError.badToken
        case 429: throw ClientError.rateLimited
        default: throw ClientError.http(status)
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let value = obj["cookie"] as? String, Self.isCookie(value) else { throw ClientError.badReply }
        cookie = value
        do {
            try writePrivateFile(paths.sessionFile, value + "\n")
        } catch {
            paths.log("could not save \(paths.sessionFile.lastPathComponent); signing in again next time")
        }
        paths.log("paired with CAST as \"\(Self.deviceName)\"")
    }

    private func send(_ method: String, _ port: Int, _ path: String, _ body: [String: Any]?,
                      signedIn: Bool = true) async throws -> (Int, Data) {
        var request = URLRequest(url: endpoint(port, path), timeoutInterval: 5)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if signedIn, let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let (data, response) = try await session.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        } catch let error as URLError where error.code == .cannotConnectToHost || error.code == .networkConnectionLost {
            throw ClientError.unreachable
        }
    }

    /// One `name=value` pair and nothing that could start another header.
    private static func isCookie(_ text: String) -> Bool {
        text.count < 1024 && text.range(of: "^[A-Za-z0-9_.-]+=[A-Za-z0-9._~%+/=-]+$", options: .regularExpression) != nil
    }
}

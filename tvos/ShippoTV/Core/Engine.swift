import Foundation
import JavaScriptCore
import CryptoKit
import CommonCrypto

/// Le moteur ShippoTV (le même que sur la télé Samsung et l'iPad : Xtream, catalogue, TMDB, guide TV,
/// synchronisation) exécuté dans JavaScriptCore. Swift lui fournit le réseau, le stockage, les minuteurs
/// et la cryptographie ; l'interface l'interroge avec les mêmes routes que les autres versions (/api/...).
final class Engine {
    static let shared = Engine()

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private let queue = DispatchQueue(label: "shippotv.engine", qos: .userInitiated)
    private var ctx: JSContext!
    private let store = KVStore()
    private var started = false
    /// Profil actif, transmis à chaque appel (comme l'en-tête X-Profile des autres versions).
    var profile = ""

    // MARK: - Démarrage

    /// Charge le pont puis le moteur. `testDefaults` : valeurs remplaçant celles intégrées (captures GitHub).
    func start(testDefaults: [String: Any]? = nil) {
        guard !started else { return }
        started = true
        queue.sync {
            ctx = JSContext(virtualMachine: JSVirtualMachine())
            ctx.name = "ShippoTV"
            ctx.exceptionHandler = { _, exc in
                let msg = exc?.toString() ?? "?"
                let stack = exc?.objectForKeyedSubscript("stack")?.toString() ?? ""
                NSLog("[moteur] exception : %@ %@", msg, stack)
            }
            installNatives()
            let dir = Bundle.main.resourceURL!.appendingPathComponent("Engine", isDirectory: true)
            let order: [String] = (try? JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("order.json")))) as? [String]
                ?? ["bridge.js", "defaults.js", "store.js", "tvguide.js", "verify.js", "catalog.js", "sync.js", "app.js"]
            for f in order {
                guard let src = try? String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8) else {
                    NSLog("[moteur] fichier manquant : %@", f)
                    continue
                }
                ctx.evaluateScript(src, withSourceURL: URL(string: "shippo://engine/" + f))
                if f == "defaults.js", let t = testDefaults, let data = try? JSONSerialization.data(withJSONObject: t),
                   let json = String(data: data, encoding: .utf8) {
                    ctx.evaluateScript("Object.assign(window.SHIPPO_DEFAULTS, \(json));")
                }
            }
            NSLog("[moteur] prêt (%@)", ctx.evaluateScript("ENGINE && ENGINE.version")?.toString() ?? "?")
        }
    }

    // MARK: - Appels du moteur (mêmes routes que l'interface web)

    func data(_ path: String, _ body: [String: Any]? = nil) async throws -> Data {
        let bodyJSON: String? = try body.map { String(data: try JSONSerialization.data(withJSONObject: $0), encoding: .utf8) ?? "{}" }
        let prof = profile
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            queue.async {
                var done = false
                let cb: @convention(block) (JSValue?, JSValue?) -> Void = { err, res in
                    guard !done else { return }
                    done = true
                    if let e = err, !e.isNull, !e.isUndefined {
                        cont.resume(throwing: Failure(message: e.toString()))
                    } else {
                        cont.resume(returning: (res?.toString() ?? "null").data(using: .utf8) ?? Data())
                    }
                }
                let fn = self.ctx.objectForKeyedSubscript("__call")
                fn?.call(withArguments: [path, bodyJSON as Any? ?? NSNull(), prof, unsafeBitCast(cb, to: AnyObject.self)])
            }
        }
    }

    func call<T: Decodable>(_ path: String, _ body: [String: Any]? = nil, as type: T.Type = T.self) async throws -> T {
        let d = try await data(path, body)
        return try JSONDecoder().decode(T.self, from: d)
    }

    /// Appel dont on ignore la réponse (enregistrement de la progression, etc.).
    func send(_ path: String, _ body: [String: Any]? = nil) {
        Task { _ = try? await data(path, body) }
    }

    /// Écrit tout de suite les réglages en attente (mise en arrière-plan de l'appli).
    func flush() {
        queue.async { self.ctx.evaluateScript("ENGINE && ENGINE.flush && ENGINE.flush()") }
    }

    // MARK: - Fonctions natives

    private func installNatives() {
        let c: JSContext = ctx

        let log: @convention(block) (String, String) -> Void = { level, msg in
            NSLog("[moteur %@] %@", level, msg)
        }
        c.setObject(unsafeBitCast(log, to: AnyObject.self), forKeyedSubscript: "__log" as NSString)

        let timer: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in
            guard let self = self else { return }
            self.queue.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, ms)))) {
                self.ctx.objectForKeyedSubscript("__fire")?.call(withArguments: [id])
            }
        }
        c.setObject(unsafeBitCast(timer, to: AnyObject.self), forKeyedSubscript: "__timer" as NSString)

        let random: @convention(block) (Int) -> String = { n in
            var b = [UInt8](repeating: 0, count: max(0, n))
            _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
            return Data(b).base64EncodedString()
        }
        c.setObject(unsafeBitCast(random, to: AnyObject.self), forKeyedSubscript: "__random" as NSString)

        let crypto: @convention(block) (String, String) -> JSValue = { op, json in
            let ctx = JSContext.current()!
            guard let out = CryptoOps.run(op, json) else { return JSValue(nullIn: ctx) }
            return JSValue(object: out, in: ctx)
        }
        c.setObject(unsafeBitCast(crypto, to: AnyObject.self), forKeyedSubscript: "__crypto" as NSString)

        let native: @convention(block) (String, JSValue) -> Void = { [weak self] json, cb in
            guard let self = self else { return }
            let reply: (Any?, String?) -> Void = { res, err in
                self.queue.async {
                    cb.call(withArguments: [err as Any? ?? NSNull(), res ?? NSNull()])
                }
            }
            guard let d = json.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                  let cmd = m["cmd"] as? String else { reply(nil, "message invalide"); return }
            switch cmd {
            case "http":
                HTTPBridge.request(m) { result in
                    switch result {
                    case .success(let r): reply(r, nil)
                    case .failure(let e): reply(nil, e.localizedDescription)
                    }
                }
            case "kv":
                self.store.handle(m) { out in reply(out, nil) }
            default:
                reply(nil, "commande inconnue : \(cmd)")
            }
        }
        c.setObject(unsafeBitCast(native, to: AnyObject.self), forKeyedSubscript: "__native" as NSString)

        let langs = Locale.preferredLanguages
        let env: [String: Any] = ["lang": langs.first ?? "fr-FR", "langs": langs.isEmpty ? ["fr-FR"] : langs]
        c.setObject(env, forKeyedSubscript: "__env" as NSString)
    }
}

// MARK: - Réseau

enum HTTPBridge {
    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpMaximumConnectionsPerHost = 6
        c.timeoutIntervalForResource = 300
        return URLSession(configuration: c)
    }()

    static func request(_ b: [String: Any], done: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let s = b["url"] as? String, let url = URL(string: s) else {
            done(.failure(Engine.Failure(message: "adresse invalide")))
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = (b["method"] as? String) ?? "GET"
        req.timeoutInterval = (b["timeout"] as? NSNumber)?.doubleValue ?? 60
        if let h = b["headers"] as? [String: Any] {
            for (k, v) in h { req.setValue("\(v)", forHTTPHeaderField: k) }
        }
        if let body = b["body"] as? String { req.httpBody = body.data(using: .utf8) }
        session.dataTask(with: req) { data, resp, err in
            if let err = err {
                done(.failure(Engine.Failure(message: (err as NSError).code == NSURLErrorTimedOut ? "délai dépassé" : "réseau")))
                return
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let text = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            done(.success(["status": code, "text": text]))
        }.resume()
    }
}

// MARK: - Stockage
/// Sur Apple TV, seule une petite réserve est garantie durable (préférences, ~500 Ko) ; les fichiers
/// peuvent être effacés par le système. Réglages, profils, reprises et clé de synchronisation vont donc
/// dans les préférences ; catalogue et fiches TMDB (retéléchargeables) dans le cache.
final class KVStore {
    private static let durable: Set<String> = ["config", "synchro", "verifications"]
    private let defaults = UserDefaults.standard
    private let dir: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("ShippoTV", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private let io = DispatchQueue(label: "shippotv.kv")

    private func file(_ key: String) -> URL {
        let safe = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
        return dir.appendingPathComponent(safe + ".json")
    }

    func handle(_ b: [String: Any], reply: @escaping (Any?) -> Void) {
        io.async {
            let key = (b["key"] as? String) ?? ""
            let durable = Self.durable.contains(key)
            var out: Any? = nil
            switch b["op"] as? String {
            case "get":
                out = durable ? self.defaults.string(forKey: "kv." + key) : try? String(contentsOf: self.file(key), encoding: .utf8)
            case "set":
                if let v = b["value"] as? String {
                    if durable {
                        self.defaults.set(v, forKey: "kv." + key)
                        out = true
                    } else {
                        out = (try? v.write(to: self.file(key), atomically: true, encoding: .utf8)) != nil
                    }
                }
            case "del":
                if durable { self.defaults.removeObject(forKey: "kv." + key) } else { try? FileManager.default.removeItem(at: self.file(key)) }
                out = true
            default:
                break
            }
            reply(out)
        }
    }
}

// MARK: - Cryptographie (sous-ensemble de WebCrypto utilisé par la synchronisation)

enum CryptoOps {
    static func run(_ op: String, _ json: String) -> String? {
        guard let d = json.data(using: .utf8), let a = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        let B: (String) -> Data = { Data(base64Encoded: (a[$0] as? String) ?? "") ?? Data() }
        switch op {
        case "digest":
            let data = B("data")
            switch (a["alg"] as? String ?? "").uppercased() {
            case "SHA-1": return Data(Insecure.SHA1.hash(data: data)).base64EncodedString()
            case "SHA-384": return Data(SHA384.hash(data: data)).base64EncodedString()
            case "SHA-512": return Data(SHA512.hash(data: data)).base64EncodedString()
            default: return Data(SHA256.hash(data: data)).base64EncodedString()
            }
        case "hmac":
            let key = SymmetricKey(data: B("key"))
            return Data(HMAC<SHA256>.authenticationCode(for: B("data"), using: key)).base64EncodedString()
        case "pbkdf2":
            let pass = B("key"), salt = B("salt")
            let iters = UInt32((a["iterations"] as? NSNumber)?.intValue ?? 1)
            let len = ((a["bits"] as? NSNumber)?.intValue ?? 256) / 8
            var out = [UInt8](repeating: 0, count: len)
            let st = pass.withUnsafeBytes { p in
                salt.withUnsafeBytes { s in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         p.baseAddress?.assumingMemoryBound(to: Int8.self), pass.count,
                                         s.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                                         CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), iters, &out, len)
                }
            }
            return st == Int32(kCCSuccess) ? Data(out).base64EncodedString() : nil
        case "aesgcm_seal":
            guard let nonce = try? AES.GCM.Nonce(data: B("iv")),
                  let box = try? AES.GCM.seal(B("data"), using: SymmetricKey(data: B("key")), nonce: nonce, authenticating: B("aad"))
            else { return nil }
            return (box.ciphertext + box.tag).base64EncodedString()
        case "aesgcm_open":
            let data = B("data")
            guard data.count >= 16, let nonce = try? AES.GCM.Nonce(data: B("iv")),
                  let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: data.prefix(data.count - 16), tag: data.suffix(16)),
                  let plain = try? AES.GCM.open(box, using: SymmetricKey(data: B("key")), authenticating: B("aad"))
            else { return nil }
            return plain.base64EncodedString()
        default:
            return nil
        }
    }
}

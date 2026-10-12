import UIKit
import WebKit

/// Affiche l'interface web embarquée (dossier « web » de l'appli) et lui fournit ce que le
/// navigateur ne sait pas faire seul : requêtes réseau sans restriction, stockage durable,
/// lecteur vidéo natif, ouverture d'autres applis (YouTube).
final class WebViewController: UIViewController, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!
    private let store = KVStore()
    private var player: PlayerViewController?

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: "shippo")
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let ucc = WKUserContentController()
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        var boot = "window.SHIPPO_IOS = true; window.SHIPPO_NO_WORKER = true;"
        if let test = TestConfig.json() {
            boot += "window.SHIPPO_TEST = \(test);"
        }
        ucc.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 6 / 255, green: 4 / 255, blue: 8 / 255, alpha: 1)
        wv.scrollView.backgroundColor = wv.backgroundColor
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsLinkPreview = false
        wv.navigationDelegate = self
        wv.uiDelegate = self
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        webView = wv
        view = wv
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // balayage depuis le bord gauche : page précédente, comme partout sur iPad
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeBack(_:)))
        edge.edges = .left
        webView.addGestureRecognizer(edge)
        if let url = URL(string: "shippo://app/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    @objc private func edgeBack(_ g: UIScreenEdgePanGestureRecognizer) {
        if g.state == .ended && g.translation(in: view).x > 70 {
            webView.evaluateJavaScript("window.IOS_BACK && window.IOS_BACK()", completionHandler: nil)
        }
    }

    // MARK: - Messages venant de l'interface

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "message invalide")
            return
        }
        switch cmd {
        case "http":
            HTTPBridge.request(body) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let r): replyHandler(r, nil)
                    case .failure(let e): replyHandler(nil, e.localizedDescription)
                    }
                }
            }
        case "kv":
            store.handle(body) { out in replyHandler(out, nil) }
        case "play":
            showPlayer(body)
            replyHandler(true, nil)
        case "stop":
            player?.closeFromApp()
            replyHandler(true, nil)
        case "haptic":
            let style: UIImpactFeedbackGenerator.FeedbackStyle = (body["style"] as? String) == "medium" ? .medium : .light
            UIImpactFeedbackGenerator(style: style).impactOccurred()
            replyHandler(true, nil)
        case "openURL":
            if let s = body["url"] as? String, let url = URL(string: s) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                replyHandler(true, nil)
            } else {
                replyHandler(nil, "adresse invalide")
            }
        default:
            replyHandler(nil, "commande inconnue : \(cmd)")
        }
    }

    // MARK: - Lecteur natif

    private func showPlayer(_ payload: [String: Any]) {
        if let p = player, p.presentingViewController != nil {
            p.load(payload)              // épisode suivant, autre chaîne : même lecteur
            return
        }
        let p = PlayerViewController()
        p.onEvent = { [weak self] ev in self?.sendToPage(ev) }
        p.onDismiss = { [weak self] in self?.player = nil }
        p.modalPresentationStyle = .fullScreen
        p.load(payload)
        player = p
        present(p, animated: true)
    }

    private func sendToPage(_ ev: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: ev),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.IOS_PLAYER && window.IOS_PLAYER(\(json))", completionHandler: nil)
    }

    // MARK: - Navigation : les liens externes s'ouvrent hors de l'appli

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https",
           navigationAction.targetFrame?.isMainFrame ?? true {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()                 // mémoire saturée : on recharge proprement
    }
}

// MARK: - Fichiers de l'interface (shippo://app/…)

final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            let r = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!
            urlSchemeTask.didReceive(r)
            urlSchemeTask.didReceive(Data())
            urlSchemeTask.didFinish()
            return
        }
        let headers = ["Content-Type": Self.mime(file.pathExtension), "Content-Length": "\(data.count)",
                       "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"]
        let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(r)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "woff2": return "font/woff2"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Réseau (requêtes de l'interface, sans restriction de domaine)

struct BridgeError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

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
            done(.failure(BridgeError("adresse invalide")))
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
                done(.failure(BridgeError((err as NSError).code == NSURLErrorTimedOut ? "délai dépassé" : "réseau")))
                return
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let text = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            done(.success(["status": code, "text": text]))
        }.resume()
    }
}

// MARK: - Stockage durable (réglages, catalogue, reprises) dans des fichiers

final class KVStore {
    private let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("ShippoTV", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private let queue = DispatchQueue(label: "shippotv.kv")

    private func file(_ key: String) -> URL {
        let safe = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
        return dir.appendingPathComponent(safe + ".json")
    }

    func handle(_ b: [String: Any], reply: @escaping (Any?) -> Void) {
        queue.async {
            let key = (b["key"] as? String) ?? ""
            var out: Any? = nil
            switch b["op"] as? String {
            case "get":
                out = try? String(contentsOf: self.file(key), encoding: .utf8)
            case "set":
                if let v = b["value"] as? String {
                    out = (try? v.write(to: self.file(key), atomically: true, encoding: .utf8)) != nil
                }
            case "del":
                try? FileManager.default.removeItem(at: self.file(key))
                out = true
            default:
                break
            }
            DispatchQueue.main.async { reply(out) }
        }
    }
}

// MARK: - Mode test (fabrication GitHub : captures d'écran avec un faux fournisseur)

enum TestConfig {
    static func json() -> String? {
        guard let s = ProcessInfo.processInfo.environment["SHIPPO_TEST"], let d = s.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: d)) != nil else { return nil }
        return s
    }
}

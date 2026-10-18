import SwiftUI
import UIKit

/// Couleurs ShippoTV (thème « Fusion » bordeaux, comme sur PC, télé et iPad).
enum Theme {
    static let bg = Color(red: 11 / 255, green: 6 / 255, blue: 9 / 255)
    static let accent = Color(red: 165 / 255, green: 29 / 255, blue: 67 / 255)
    static let accent2 = Color(red: 243 / 255, green: 167 / 255, blue: 187 / 255)
    static let wine = Color(red: 214 / 255, green: 55 / 255, blue: 95 / 255)
    static let muted = Color.white.opacity(0.62)

    /// Teinte stable dérivée d'un titre (affiches sans image).
    static func hue(_ s: String) -> Color {
        var h: UInt32 = 2166136261
        for b in s.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        return Color(hue: Double(h % 360) / 360, saturation: 0.55, brightness: 0.42)
    }
}

/// Fond d'ambiance : halos bordeaux sur fond sombre.
struct AmbientBackground: View {
    var tint: Color = Theme.accent
    var body: some View {
        ZStack {
            Theme.bg
            RadialGradient(colors: [tint.opacity(0.55), .clear], center: UnitPoint(x: 0.1, y: -0.1), startRadius: 0, endRadius: 1100)
            RadialGradient(colors: [Color(red: 0.43, green: 0.08, blue: 0.19).opacity(0.45), .clear], center: UnitPoint(x: 1.05, y: 1.1), startRadius: 0, endRadius: 1000)
        }
        .ignoresSafeArea()
    }
}

/// Image distante avec repli dégradé + titre (pas de clé TMDB, image absente).
/// Chargement maison (ImageStore) plutôt qu'AsyncImage : AsyncImage abandonne une image quand l'écran se
/// redessine pendant le téléchargement et ne réessaie jamais. Ici l'image est gardée en mémoire, partagée entre
/// les cartes, redemandée en cas d'échec, et chaque carte affichée est comptée (Réglages › Diagnostic).
struct RemoteImage: View {
    let url: URL?
    let title: String
    var showTitle = true
    @State private var image: UIImage?
    @State private var slot = UUID()

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.hue(title), Theme.hue(title).opacity(0.35), Theme.bg], startPoint: .topLeading, endPoint: .bottomTrailing)
            if showTitle && image == nil {
                Text(title)
                    .font(.system(size: 26, weight: .bold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.92))
                    .padding(18)
            }
            if ImageStats.legacy, let url = url {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.35))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFill().transition(.opacity).onAppear { ImageStats.shared.mark(slot, .ok) }
                    case .failure: Color.clear.onAppear { ImageStats.shared.mark(slot, .failed) }
                    default: Color.clear.onAppear { ImageStats.shared.mark(slot, .loading) }
                    }
                }
            } else if let img = image {
                Image(uiImage: img).resizable().scaledToFill().transition(.opacity)
            }
        }
        .clipped()
        .onAppear { ImageStats.shared.mark(slot, url == nil ? .noURL : (image != nil ? .ok : .loading), keepDone: true) }
        .onDisappear { ImageStats.shared.drop(slot) }
        .task(id: url) {
            guard !ImageStats.legacy else { ImageStats.shared.mark(slot, url == nil ? .noURL : .loading, keepDone: url != nil); return }
            guard let url = url else { image = nil; ImageStats.shared.mark(slot, .noURL); return }
            if let img = ImageStore.shared.cached(url) { image = img; ImageStats.shared.mark(slot, .ok); return }
            image = nil
            ImageStats.shared.mark(slot, .loading)
            if let img = await ImageStore.shared.load(url) {
                withAnimation(.easeOut(duration: 0.3)) { image = img }
                ImageStats.shared.mark(slot, .ok)
            } else if !Task.isCancelled {
                ImageStats.shared.mark(slot, .failed)
            }
        }
    }
}

/// Images téléchargées une seule fois (même affiche dans plusieurs rangées), gardées en mémoire,
/// 3 essais en cas d'échec réseau, 6 téléchargements à la fois au maximum.
actor ImageStore {
    static let shared = ImageStore()
    private nonisolated(unsafe) static let memory: NSCache<NSURL, UIImage> = {
        let c = NSCache<NSURL, UIImage>()
        c.totalCostLimit = 160 * 1024 * 1024
        return c
    }()
    private var running: [URL: Task<UIImage?, Never>] = [:]
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    nonisolated func cached(_ url: URL) -> UIImage? { Self.memory.object(forKey: url as NSURL) }

    func load(_ url: URL) async -> UIImage? {
        if let img = cached(url) { return img }
        if let t = running[url] { return await t.value }
        // le téléchargement continue même si la carte quitte l'écran : l'image servira au retour
        let t = Task<UIImage?, Never> { await self.fetch(url) }
        running[url] = t
        let img = await t.value
        running[url] = nil
        return img
    }

    private func fetch(_ url: URL) async -> UIImage? {
        await acquire()
        defer { release() }
        for attempt in 0..<3 {
            if attempt > 0 { try? await Task.sleep(nanoseconds: UInt64(attempt) * 800_000_000) }
            ImageStats.shared.count(.started)
            do {
                var req = URLRequest(url: url)
                req.timeoutInterval = 20
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if code == 404 { ImageStats.shared.count(.http404); return nil }
                guard code == 200, let raw = UIImage(data: data) else { ImageStats.shared.count(.badData); continue }
                let img = raw.preparingForDisplay() ?? raw
                Self.memory.setObject(img, forKey: url as NSURL, cost: data.count * 4)
                ImageStats.shared.count(.done)
                return img
            } catch {
                ImageStats.shared.count(.netError, (error as NSError).code)
            }
        }
        return nil
    }

    private func acquire() async {
        if active < 6 { active += 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    private func release() {
        if waiters.isEmpty { active -= 1 } else { waiters.removeFirst().resume() }
    }
}

/// Compteurs des affiches : cartes à l'écran (avec image / en cours / échec / sans fiche) et téléchargements.
/// Lus par Réglages › Diagnostic et écrits dans le journal pendant les essais GitHub.
final class ImageStats: @unchecked Sendable {
    static let shared = ImageStats()
    /// Essais GitHub : « async » remet l'ancien AsyncImage pour comparer.
    static let legacy = ProcessInfo.processInfo.environment["SHIPPO_IMG"] == "async"
    enum State { case noURL, loading, ok, failed }
    enum Counter: String { case started, done, http404, badData, netError }
    private let lock = NSLock()
    private var slots: [UUID: State] = [:]
    private var counters: [Counter: Int] = [:]
    private var errors: [Int: Int] = [:]

    func mark(_ id: UUID, _ s: State, keepDone: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        if keepDone, let cur = slots[id], cur == .ok || cur == .failed { return }
        slots[id] = s
    }
    func drop(_ id: UUID) { lock.lock(); slots[id] = nil; lock.unlock() }
    func count(_ c: Counter, _ code: Int? = nil) {
        lock.lock(); counters[c, default: 0] += 1; if let e = code { errors[e, default: 0] += 1 }; lock.unlock()
    }
    var summary: String {
        lock.lock(); defer { lock.unlock() }
        let v = slots.values
        let ok = v.filter { $0 == .ok }.count, ld = v.filter { $0 == .loading }.count
        let ko = v.filter { $0 == .failed }.count, nu = v.filter { $0 == .noURL }.count
        let errs = errors.map { "\($0.key)×\($0.value)" }.joined(separator: " ")
        return "cartes affichées \(v.count) : \(ok) avec image, \(ld) en cours, \(ko) en échec, \(nu) sans fiche · téléchargements \(counters[.done] ?? 0)/\(counters[.started] ?? 0), 404 \(counters[.http404] ?? 0), illisibles \(counters[.badData] ?? 0), erreurs réseau \(counters[.netError] ?? 0)\(errs.isEmpty ? "" : " (\(errs))")\(Self.legacy ? " [AsyncImage]" : "")"
    }
}

/// Petite étiquette (qualité, note).
struct Badge: View {
    let text: String
    var accent = false
    var body: some View {
        Text(text)
            .font(.system(size: 20, weight: .heavy))
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(accent ? Theme.accent : Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .foregroundStyle(.white)
    }
}

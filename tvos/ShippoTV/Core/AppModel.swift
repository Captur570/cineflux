import Foundation
import SwiftUI

/// État de l'appli : configuration, catalogue, fiches TMDB, Ma liste, reprises.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, setup, profiles, ready, failed(String) }

    @Published var phase: Phase = .loading {
        didSet { if phase != oldValue { Diag.step("écran → \(phase)"); if joinT0 != nil { trace("écran affiché : \(phase)") } } }
    }
    /// Suivi pas à pas de l'association (affiché sur l'écran de bienvenue et dans le Diagnostic).
    @Published var joinTrace: [String] = []
    private var joinT0: Date?
    /// Essais GitHub : position actuelle du parcours automatique de l'accueil.
    var testMark = ""
    /// Essais GitHub : journal écrit dans Documents/essai.txt (lu par simctl, plus fiable que le journal système).
    static func appendTestLog(_ line: String) {
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let url = dir.appendingPathComponent("essai.txt")
        let data = Data((line + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() }
        else { try? data.write(to: url) }
    }

    func trace(_ s: String, start: Bool = false) {
        if start || joinT0 == nil { joinT0 = Date(); joinTrace = [] }
        let line = String(format: "%5.1f s  ", Date().timeIntervalSince(joinT0 ?? Date())) + s
        joinTrace.append(line)
        NSLog("[association] %@", line)
        if test != nil { Self.appendTestLog("[association] " + line) }
    }
    @Published var cfg: Config?
    @Published var catalog: Catalog?
    @Published var meta: [String: Meta] = [:]
    @Published var discover: [DiscoverRow] = []
    @Published var info: [String: MovieInfo] = [:]
    @Published var toast: String?
    @Published var busy: String?
    var lastJoin: String?
    var lastMetaError: String?

    let test = TestConfig.load()
    private var movieIdx: [String: Movie] = [:]
    private var pendingMeta = Set<String>()

    var profileId: String {
        get { UserDefaults.standard.string(forKey: "profile") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "profile"); Engine.shared.profile = newValue }
    }

    // MARK: - Démarrage

    func start() async {
        Diag.step("démarrage du moteur")
        var td: [String: Any]? = nil
        if let t = test {
            td = [:]
            if let a = t.tmdbApi { td?["tmdb_api"] = a }
            if let k = t.tmdbKey { td?["tmdb_key"] = k }
            if let u = t.syncUrl { td?["supabase_url"] = u; td?["supabase_key"] = t.syncKey ?? "" }
            startStatsLog()
        }
        Engine.shared.profile = profileId
        Engine.shared.start(testDefaults: td)
        Diag.step("moteur chargé")
        if let t = test, t.route != "setup", t.route != "join", let server = t.server {
            _ = try? await Engine.shared.data("/api/config", ["server": server, "username": t.user ?? "", "password": t.pass ?? "", "country": "FR"])
        }
        await load()
    }

    func load() async {
        if case .ready = phase {} else if phase != .loading { phase = .loading }   // retour visible tout de suite (code, QR, saisie)
        do {
            Diag.step("lecture des réglages")
            let c: Config = try await Engine.shared.call("/api/config")
            cfg = c
            Diag.step("réglages lus (configuré : \(c.configured))")
            if joinT0 != nil { trace("réglages relus : abonnement \(c.configured ? "configuré" : "NON configuré"), \(c.profiles.count) profil(s)") }
            if !c.configured { phase = .setup; launchDone(); return }
            if c.profiles.count > 1 && !c.profiles.contains(where: { $0.id == profileId }) { phase = .profiles; return }
            if !c.profiles.contains(where: { $0.id == profileId }), let first = c.profiles.first { profileId = first.id }
            Diag.step("chargement du catalogue")
            try await loadCatalog()
            Diag.step("catalogue chargé (\(catalog?.movies.count ?? 0) films)")
            if joinT0 != nil { trace("catalogue chargé : \(catalog?.movies.count ?? 0) films") }
            phase = .ready
            launchDone()
        } catch {
            Diag.step("erreur : \(error.localizedDescription)")
            phase = cfg?.configured == true ? .failed(error.localizedDescription) : .setup
            launchDone()
        }
    }

    private func launchDone() {
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            Diag.finished()
        }
    }

    func loadCatalog() async throws {
        let cat: Catalog = try await Engine.shared.call("/api/catalog")
        catalog = cat
        movieIdx = Dictionary(cat.movies.map { ($0.k, $0) }, uniquingKeysWith: { a, _ in a })
        meta.merge(cat.meta ?? [:]) { a, _ in a }
        Task {
            await loadDiscover()
            prefetchPosters()
        }
        prefetchPosters()
        startEventLoop()
    }

    func reloadConfig() async {
        guard let c: Config = try? await Engine.shared.call("/api/config") else { return }
        let gotTMDB = c.has_tmdb == true && cfg?.has_tmdb != true
        cfg = c
        if gotTMDB { pendingMeta.removeAll(); metaMiss.removeAll(); prefetchPosters() }   // la clé vient d'arriver
        // profil supprimé ou nouveaux profils arrivés par la synchro
        if phase == .ready, !c.profiles.contains(where: { $0.id == profileId }) {
            if c.profiles.count > 1 { phase = .profiles } else if let f = c.profiles.first { profileId = f.id }
        }
    }

    /// Affiches des rangées visibles demandées d'emblée (sans attendre leur apparition à l'écran),
    /// et de nouveau dès que la clé TMDB arrive.
    func prefetchPosters() {
        guard cfg?.has_tmdb == true, catalog != nil else { return }
        var seen = Set<String>()
        var list: [Movie] = []
        let add: ([Movie]) -> Void = { ms in for m in ms where !seen.contains(m.k) { seen.insert(m.k); list.append(m) } }
        add(resumeMovies.map(\.movie))
        add(favMovies)
        add(Array(recentMovies.prefix(30)))
        for row in discover { add(Array(movies(for: row).prefix(20))) }
        for row in categoryRows { add(Array(row.items.prefix(16))) }
        want(list, front: false)
    }

    /// Changements venus des autres appareils (synchronisation) : réglages relus toutes les 30 s.
    // MARK: - Messages du moteur (comme l'interface du PC, de la télé et de l'iPad)

    struct EngineEvent: Decodable { let id: Int; let msg: String?; let kind: String? }
    @Published var lastEvents: [String] = []
    private var listening = false
    private var eventId = -1

    private func startEventLoop() {
        guard !listening else { return }
        listening = true
        Task {
            while true {
                await pollEvents()
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
        }
    }

    private func pollEvents() async {
        guard let evs: [EngineEvent] = try? await Engine.shared.call("/api/events?since=\(max(0, eventId))") else { return }
        if eventId < 0 { eventId = evs.map(\.id).max() ?? 0; return }        // au démarrage : on part des messages à venir
        for e in evs {
            eventId = max(eventId, e.id)
            lastEvents.append("\(e.kind ?? "?")\((e.msg ?? "").isEmpty ? "" : " : " + (e.msg ?? ""))")
            if lastEvents.count > 12 { lastEvents.removeFirst(lastEvents.count - 12) }
            switch e.kind {
            case "sync":
                await reloadConfig()
            case "catalog":
                try? await loadCatalog()
                if let m = e.msg, !m.isEmpty { toast = m }
            case "tmdb_key":
                if let m = e.msg, !m.isEmpty { toast = m }
                await reloadConfig()
            case "remote_stop":
                PlayerPresenter.closeIfOpen()
                if let m = e.msg, !m.isEmpty { toast = m }
            default:
                break
            }
        }
    }

    func chooseProfile(_ p: Profile) async {
        profileId = p.id
        phase = .loading
        await load()
    }

    private func loadDiscover() async {
        guard let d: Discover = try? await Engine.shared.call("/api/discover?kind=movie") else { return }
        discover = d.rows.filter { ($0.kind ?? "movie") == "movie" }
    }

    // MARK: - Catalogue

    func movie(_ key: String) -> Movie? { movieIdx[key] }

    func movies(for row: DiscoverRow) -> [Movie] {
        (row.keys ?? []).compactMap { movieIdx[$0] }
    }

    struct CategoryRow: Identifiable { let id: String; let title: String; let items: [Movie] }
    struct ResumeEntry: Identifiable { let movie: Movie; let progress: WatchProgress; var id: String { movie.k } }

    var categoryRows: [CategoryRow] {
        guard let cat = catalog else { return [] }
        let names = cat.cats?.movies ?? [:]
        let order = cat.cats?.order?.movies ?? Array(names.keys).sorted()
        var byCat: [String: [Movie]] = [:]
        for m in cat.movies { for c in m.c?.items ?? [] { byCat[c, default: []].append(m) } }
        return order.compactMap { id in
            guard let items = byCat[id], !items.isEmpty else { return nil }
            return CategoryRow(id: id, title: names[id] ?? "Films", items: items.sorted { ($0.a ?? 0) > ($1.a ?? 0) })
        }
    }

    var recentMovies: [Movie] {
        (catalog?.movies ?? []).sorted { ($0.a ?? 0) > ($1.a ?? 0) }
    }

    /// Films commencés et pas terminés, du plus récent au plus ancien.
    var resumeMovies: [ResumeEntry] {
        let prog = cfg?.progress ?? [:]
        return prog.compactMap { k, p -> ResumeEntry? in
            guard k.hasPrefix("m:"), p.done != true, (p.pos ?? 0) > 30, let m = movieIdx[String(k.dropFirst(2))] else { return nil }
            return ResumeEntry(movie: m, progress: p)
        }.sorted { ($0.progress.ts ?? 0) > ($1.progress.ts ?? 0) }
    }

    var favMovies: [Movie] {
        (cfg?.favs ?? []).compactMap { f in f.hasPrefix("movie:") ? movieIdx[String(f.dropFirst(6))] : nil }
    }

    func isFav(_ m: Movie) -> Bool { (cfg?.favs ?? []).contains("movie:" + m.k) }

    func toggleFav(_ m: Movie) async {
        _ = try? await Engine.shared.data("/api/fav", ["kind": "movie", "key": m.k, "on": !isFav(m)])
        await reloadConfig()
    }

    func progress(_ m: Movie) -> WatchProgress? {
        guard let p = cfg?.progress?["m:" + m.k], p.done != true, (p.pos ?? 0) > 30 else { return nil }
        return p
    }

    /// Une mise en avant : film populaire du moment présent dans le catalogue, sinon le plus récent avec une image.
    var featured: Movie? {
        let trend = discover.first.map { movies(for: $0) } ?? []
        let pool = trend + recentMovies
        return pool.first { meta["m:" + $0.k]?.b != nil } ?? pool.first
    }

    // MARK: - Fiches TMDB (affiches), chargées à la demande comme sur les autres versions

    func title(_ m: Movie) -> String { meta["m:" + m.k]?.t ?? m.t }
    func poster(_ m: Movie) -> URL? { TMDBImage.url(meta["m:" + m.k]?.p, size: "w342") }
    func backdrop(_ m: Movie, large: Bool = true) -> URL? { TMDBImage.url(meta["m:" + m.k]?.b, size: large ? "w1280" : "w780") }

    /// Fiches TMDB demandées par lots de 24, 2 lots à la fois au plus (comme sur PC, télé et iPad) :
    /// lancer tous les lots d'un coup déclenchait la limite de TMDB et des affiches manquaient.
    /// Les rangées visibles passent devant ; une affiche manquée sera redemandée (2 essais).
    private var metaQueue: [Movie] = []
    private var metaInflight = 0
    private var metaMiss: [String: Int] = [:]
    private var metaAsked = 0, metaFound = 0, metaNone = 0, metaErrors = 0

    /// État des fiches TMDB (Réglages › Diagnostic et journal des essais GitHub).
    var metaSummary: String {
        "fiches \(meta.count) · demandées \(metaAsked), trouvées \(metaFound), introuvables \(metaNone), lots en erreur \(metaErrors) · file d'attente \(metaQueue.count), lots en cours \(metaInflight)"
    }

    /// Essais GitHub : état des affiches écrit dans le journal toutes les 5 s.
    private func startStatsLog() {
        let t0 = Date()
        Task {
            while true {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                let line = "\(Int(Date().timeIntervalSince(t0))) s · \(ImageStats.shared.summary) · \(metaSummary) · écran \(phase) \(testMark)"
                NSLog("[stats] %@", line)
                Self.appendTestLog(line)
            }
        }
    }

    func want(_ items: [Movie], front: Bool = true) {
        guard cfg?.has_tmdb == true else { return }
        let missing = items.filter { meta["m:" + $0.k] == nil && !pendingMeta.contains($0.k) && (metaMiss[$0.k] ?? 0) < 2 }
        guard !missing.isEmpty else { return }
        missing.forEach { pendingMeta.insert($0.k) }
        if front { metaQueue.insert(contentsOf: missing, at: 0) } else { metaQueue.append(contentsOf: missing) }
        pumpMeta()
    }

    private func pumpMeta() {
        while metaInflight < 2 && !metaQueue.isEmpty {
            let batch = Array(metaQueue.prefix(24))
            metaQueue.removeFirst(batch.count)
            metaInflight += 1
            let body: [[String: Any]] = batch.map {
                ["kind": "movie", "key": $0.k, "title": $0.t, "year": $0.y as Any? ?? NSNull(), "tmdb": $0.tm?.json ?? NSNull()]
            }
            metaAsked += batch.count
            Task {
                defer { metaInflight -= 1; pumpMeta() }
                let res: [String: Meta?]
                do {
                    let d = try await Engine.shared.data("/api/enrich", ["items": body])
                    res = try JSONDecoder().decode([String: Meta?].self, from: d)
                } catch {
                    lastMetaError = error.localizedDescription
                    metaErrors += 1
                    batch.forEach { pendingMeta.remove($0.k); metaMiss[$0.k, default: 0] += 1 }
                    return
                }
                var add: [String: Meta] = [:]
                for m in batch {
                    if let v = res["m:" + m.k] ?? nil { add["m:" + m.k] = v; metaFound += 1 }
                    else { metaNone += 1; pendingMeta.remove(m.k); metaMiss[m.k, default: 0] += 1 }   // manquée : pourra être redemandée
                }
                if !add.isEmpty { meta.merge(add) { _, b in b } }
            }
        }
    }

    /// Fiche complète (résumé, genres, durée) pour la page d'un film.
    func fullMeta(_ m: Movie) async {
        if meta["m:" + m.k]?.o == nil, cfg?.has_tmdb == true {
            let body: [String: Any] = ["items": [["kind": "movie", "key": m.k, "title": m.t, "year": m.y as Any? ?? NSNull(), "tmdb": m.tm?.json ?? NSNull()]]]
            if let d = try? await Engine.shared.data("/api/enrich", body),
               let res = try? JSONDecoder().decode([String: Meta?].self, from: d), let v = res["m:" + m.k] ?? nil {
                meta["m:" + m.k] = v
            }
        }
        if info[m.k] == nil, let v = m.v.first,
           let i: MovieInfo = try? await Engine.shared.call("/api/movie?id=" + v.id.value) {
            info[m.k] = i
        }
    }

    // MARK: - Lecture

    /// Versions dans l'ordre de lecture : celle choisie, puis les autres de la meilleure à la moins bonne.
    func playOrder(_ m: Movie, first: Version?) -> [Version] {
        let sorted = m.v.sorted { ($0.rank ?? 0) > ($1.rank ?? 0) }
        guard let f = first else { return sorted }
        return [f] + sorted.filter { $0 != f }
    }

    func play(_ m: Movie, version: Version? = nil, fromStart: Bool = false) async {
        let prog = progress(m)
        var first = version
        if first == nil, let vid = prog?.vid { first = m.v.first { $0.id == vid } }
        let order = playOrder(m, first: first)
        var streams: [PlayerViewController.Source] = []
        for v in order {
            if let st: StreamInfo = try? await Engine.shared.call("/api/stream", ["type": "movie", "id": v.id.json, "ext": v.ext ?? "mkv", "title": m.t]) {
                streams.append(.init(url: st.url, label: versionLabel(v), id: v.id))
            }
        }
        guard !streams.isEmpty else { toast = "Aucune source ne répond pour le moment"; return }
        let start = fromStart ? 0 : (prog?.pos ?? 0)
        let sub = [m.y.map(String.init), versionLabel(order[0])].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let item = PlayerViewController.Item(title: title(m), subtitle: sub, live: false, sources: streams, start: start)
        PlayerPresenter.present(item) { [weak self] ev in self?.playerEvent(ev, movie: m) }
    }

    func playURL(_ url: String, title: String) {
        let item = PlayerViewController.Item(title: title, subtitle: "", live: false, sources: [.init(url: url, label: "Test", id: FlexID("0"))], start: 0)
        PlayerPresenter.present(item) { _ in }
    }

    private func playerEvent(_ ev: PlayerViewController.Event, movie m: Movie) {
        switch ev {
        case .progress(let pos, let dur, let src), .closed(let pos, let dur, let src):
            guard dur > 0 else { break }
            let done = pos / dur > 0.94
            var body: [String: Any] = ["id": "m:" + m.k, "kind": "movie", "key": m.k, "label": "", "pos": pos, "dur": dur, "vid": src.json]
            if done { body["clear"] = true }
            if case .progress = ev, pos < 5 { break }
            Task {
                _ = try? await Engine.shared.data("/api/progress", body)
                if case .closed = ev {
                    _ = try? await Engine.shared.data("/api/player_closed", [:])
                    await reloadConfig()
                }
            }
        }
    }

    func versionLabel(_ v: Version) -> String {
        let q = (v.q ?? "").trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? "Qualité non précisée" : q
    }
}

/// Mode test (fabrication GitHub : captures d'écran avec un faux fournisseur).
struct TestConfig: Decodable {
    let server: String?
    let user: String?
    let pass: String?
    let route: String?
    let tmdbApi: String?
    let tmdbKey: String?
    let imgBase: String?
    let syncUrl: String?
    let syncKey: String?
    let code: String?

    enum CodingKeys: String, CodingKey {
        case server, user, pass, route, code, tmdbApi = "tmdb_api", tmdbKey = "tmdb_key", imgBase = "img_base", syncUrl = "sync_url", syncKey = "sync_key"
    }

    static func load() -> TestConfig? {
        guard let s = ProcessInfo.processInfo.environment["SHIPPO_TEST"], let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TestConfig.self, from: d)
    }
}

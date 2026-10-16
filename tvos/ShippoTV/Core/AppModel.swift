import Foundation
import SwiftUI

/// État de l'appli : configuration, catalogue, fiches TMDB, Ma liste, reprises.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, setup, profiles, ready, failed(String) }

    @Published var phase: Phase = .loading
    @Published var cfg: Config?
    @Published var catalog: Catalog?
    @Published var meta: [String: Meta] = [:]
    @Published var discover: [DiscoverRow] = []
    @Published var info: [String: MovieInfo] = [:]
    @Published var toast: String?

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
        }
        Engine.shared.profile = profileId
        Engine.shared.start(testDefaults: td)
        Diag.step("moteur chargé")
        if let t = test, t.route != "setup", let server = t.server {
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
            if !c.configured { phase = .setup; launchDone(); return }
            if c.profiles.count > 1 && !c.profiles.contains(where: { $0.id == profileId }) { phase = .profiles; return }
            if !c.profiles.contains(where: { $0.id == profileId }), let first = c.profiles.first { profileId = first.id }
            Diag.step("chargement du catalogue")
            try await loadCatalog()
            Diag.step("catalogue chargé (\(catalog?.movies.count ?? 0) films)")
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
        startRefreshLoop()
    }

    func reloadConfig() async {
        guard let c: Config = try? await Engine.shared.call("/api/config") else { return }
        let gotTMDB = c.has_tmdb == true && cfg?.has_tmdb != true
        cfg = c
        if gotTMDB { pendingMeta.removeAll(); prefetchPosters() }   // la clé vient d'arriver (code du PC)
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
        var i = 0
        while i < list.count {
            want(Array(list[i..<min(list.count, i + 24)]))
            i += 24
        }
    }

    /// Changements venus des autres appareils (synchronisation) : réglages relus toutes les 30 s.
    private var refreshing = false
    private func startRefreshLoop() {
        guard !refreshing else { return }
        refreshing = true
        Task {
            while true {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await reloadConfig()
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

    func want(_ items: [Movie]) {
        guard cfg?.has_tmdb == true else { return }
        let missing = items.filter { meta["m:" + $0.k] == nil && !pendingMeta.contains($0.k) }.prefix(24)
        guard !missing.isEmpty else { return }
        missing.forEach { pendingMeta.insert($0.k) }
        let body: [[String: Any]] = missing.map { ["kind": "movie", "key": $0.k, "title": $0.t, "year": $0.y as Any? ?? NSNull()] }
        Task {
            guard let d = try? await Engine.shared.data("/api/enrich", ["items": body]),
                  let res = try? JSONDecoder().decode([String: Meta?].self, from: d) else {
                missing.forEach { pendingMeta.remove($0.k) }
                return
            }
            var add: [String: Meta] = [:]
            for (k, v) in res { if let v = v { add[k] = v } }
            meta.merge(add) { _, b in b }
        }
    }

    /// Fiche complète (résumé, genres, durée) pour la page d'un film.
    func fullMeta(_ m: Movie) async {
        if meta["m:" + m.k]?.o == nil, cfg?.has_tmdb == true {
            let body: [String: Any] = ["items": [["kind": "movie", "key": m.k, "title": m.t, "year": m.y as Any? ?? NSNull()]]]
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

    enum CodingKeys: String, CodingKey { case server, user, pass, route, tmdbApi = "tmdb_api", tmdbKey = "tmdb_key" }

    static func load() -> TestConfig? {
        guard let s = ProcessInfo.processInfo.environment["SHIPPO_TEST"], let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TestConfig.self, from: d)
    }
}

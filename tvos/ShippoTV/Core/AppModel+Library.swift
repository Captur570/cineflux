import Foundation
import SwiftUI

struct SeriesRow: Identifiable { let id: String; let title: String; let items: [Series] }
struct LiveGroup: Identifiable { let id: String; let title: String; let items: [Channel] }

/// Épisode prêt à lire, avec ce qu'il faut pour enchaîner sur le suivant.
struct EpisodeItem: Hashable {
    let season: String
    let ep: Episode
    let sid: FlexID
    var label: String {
        let z = { (n: Int) in String(format: "%02d", n) }
        let head = Int(season).map { "S\(z($0))E\(z(ep.n))" } ?? "E\(ep.n)"
        return ep.t.isEmpty || ep.t.hasPrefix("Épisode ") ? head : "\(head) – \(ep.t)"
    }
    var short: String { String(label.split(separator: "–").first ?? "").trimmingCharacters(in: .whitespaces) }
}

extension AppModel {

    // MARK: - Index du catalogue (calculés une fois par chargement)

    func buildLibrary(_ cat: Catalog) {
        // Films
        let names = cat.cats?.movies ?? [:]
        let order = cat.cats?.order?.movies ?? Array(names.keys).sorted()
        var byCat: [String: [Movie]] = [:]
        for m in cat.movies { for c in m.c?.items ?? [] { byCat[c, default: []].append(m) } }
        categoryRows = order.compactMap { id in
            guard let items = byCat[id], !items.isEmpty else { return nil }
            return CategoryRow(id: id, title: names[id] ?? "Films", items: items.sorted { ($0.a ?? 0) > ($1.a ?? 0) })
        }
        recentMovies = cat.movies.sorted { ($0.a ?? 0) > ($1.a ?? 0) }

        // Séries
        seriesIdx = Dictionary(cat.series.map { ($0.k, $0) }, uniquingKeysWith: { a, _ in a })
        recentSeries = cat.series.sorted { ($0.a ?? 0) > ($1.a ?? 0) }
        let sNames = cat.cats?.series ?? [:]
        let sOrder = cat.cats?.order?.series ?? Array(sNames.keys).sorted()
        var sByCat: [String: [Series]] = [:]
        for x in cat.series { for c in x.c?.items ?? [] { sByCat[c, default: []].append(x) } }
        seriesRows = sOrder.compactMap { id in
            guard let items = sByCat[id], !items.isEmpty else { return nil }
            return SeriesRow(id: id, title: sNames[id] ?? "Séries", items: items.sorted { ($0.a ?? 0) > ($1.a ?? 0) })
        }

        // Chaînes (déjà classées par le moteur : chaînes locales d'abord)
        liveIdx = Dictionary(cat.live.map { ($0.k, $0) }, uniquingKeysWith: { a, _ in a })
        let lNames = cat.cats?.live ?? [:]
        let lOrder = cat.cats?.order?.live ?? Array(lNames.keys).sorted()
        var lByCat: [String: [Channel]] = [:]
        for ch in cat.live { for c in ch.c?.items ?? [] { lByCat[c, default: []].append(ch) } }
        liveGroups = lOrder.compactMap { id in
            guard let items = lByCat[id], !items.isEmpty else { return nil }
            return LiveGroup(id: id, title: lNames[id] ?? "Chaînes", items: items)
        }

        // Recherche : titres normalisés (sans accents ni ponctuation)
        var idx: [(norm: String, kind: Int, key: String)] = []
        idx.reserveCapacity(cat.movies.count + cat.series.count + cat.live.count)
        for m in cat.movies { idx.append((Self.norm(m.t), 0, m.k)) }
        for x in cat.series { idx.append((Self.norm(x.t), 1, x.k)) }
        for ch in cat.live { idx.append((Self.norm(ch.t), 2, ch.k)) }
        searchIndex = idx
    }

    static func norm(_ s: String) -> String {
        let f = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "fr_FR"))
        return String(f.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " }.map(Character.init))
    }

    // MARK: - Recherche

    struct SearchResults { var movies: [Movie] = []; var series: [Series] = []; var live: [Channel] = [] }

    func search(_ q: String) -> SearchResults {
        let words = Self.norm(q).split(separator: " ").map(String.init).filter { !$0.isEmpty }
        guard !words.isEmpty else { return SearchResults() }
        var r = SearchResults()
        var scored: [(Int, Int, String)] = []
        let joined = words.joined(separator: " ")
        for e in searchIndex where words.allSatisfy({ e.norm.contains($0) }) {
            // titre qui commence par la recherche d'abord, puis titres courts
            let score = (e.norm.hasPrefix(joined) ? 0 : 1000) + e.norm.count
            scored.append((e.kind, score, e.key))
        }
        scored.sort { $0.1 < $1.1 }
        for (kind, _, key) in scored {
            switch kind {
            case 0: if r.movies.count < 60, let m = movie(key) { r.movies.append(m) }
            case 1: if r.series.count < 60, let x = seriesIdx[key] { r.series.append(x) }
            default: if r.live.count < 60, let ch = liveIdx[key] { r.live.append(ch) }
            }
        }
        return r
    }

    // MARK: - Ma liste (films, séries, chaînes ; synchronisée)

    func isFav(_ kind: String, _ key: String) -> Bool { (cfg?.favs ?? []).contains("\(kind):\(key)") }

    func toggleFav(_ kind: String, _ key: String) async {
        let on = !isFav(kind, key)
        _ = try? await Engine.shared.data("/api/fav", ["kind": kind, "key": key, "on": on])
        await reloadConfig()
        toast = on ? "Ajouté à Ma liste" : "Retiré de Ma liste"
    }

    var favSeries: [Series] {
        (cfg?.favs ?? []).compactMap { f in f.hasPrefix("series:") ? seriesIdx[String(f.dropFirst(7))] : nil }
    }

    var favChannels: [Channel] {
        (cfg?.favs ?? []).compactMap { f in f.hasPrefix("live:") ? liveIdx[String(f.dropFirst(5))] : nil }
    }

    // MARK: - Séries

    func title(_ x: Series) -> String { meta["t:" + x.k]?.t ?? x.t }
    func poster(_ x: Series) -> URL? { TMDBImage.url(meta["t:" + x.k]?.p, size: "w342") ?? TMDBImage.url(x.p, size: "w342") }
    func backdrop(_ x: Series, large: Bool = true) -> URL? {
        TMDBImage.url(meta["t:" + x.k]?.b, size: large ? "w1280" : "w780") ?? TMDBImage.url(x.bd, size: "w1280")
    }

    func series(for row: DiscoverRow) -> [Series] { (row.keys ?? []).compactMap { seriesIdx[$0] } }

    func loadSeriesDiscover() async {
        guard let d: Discover = try? await Engine.shared.call("/api/discover?kind=series") else { return }
        seriesDiscover = d.rows.filter { ($0.kind ?? "series") == "series" }
    }

    func loadUpNext() async {
        guard let u: [UpNext] = try? await Engine.shared.call("/api/up_next") else { return }
        upNext = u.filter { seriesIdx[$0.key] != nil }
        want(series: upNext.compactMap { seriesIdx[$0.key] })
    }

    /// Fiche complète d'une série (résumé) + saisons et épisodes de la première source qui répond.
    func loadSeries(_ x: Series, source: Int = 0) async -> (FlexID, SeriesInfo)? {
        if meta["t:" + x.k]?.o == nil, cfg?.has_tmdb == true {
            let body: [String: Any] = ["items": [["kind": "series", "key": x.k, "title": x.t, "year": x.y as Any? ?? NSNull(), "tmdb": x.tm?.json ?? NSNull()]]]
            if let d = try? await Engine.shared.data("/api/enrich", body),
               let res = try? JSONDecoder().decode([String: Meta?].self, from: d), let v = res["t:" + x.k] ?? nil {
                meta["t:" + x.k] = v
            }
        }
        let order = Array(x.s.indices.dropFirst(source)) + Array(x.s.indices.prefix(source))
        for i in order {
            let sid = x.s[i].id
            if let cached = seriesInfo[sid.value] { return (sid, cached) }
            if let info: SeriesInfo = try? await Engine.shared.call("/api/series?id=" + sid.value), !info.seasons.isEmpty {
                seriesInfo[sid.value] = info
                return (sid, info)
            }
        }
        return nil
    }

    func episodes(_ info: SeriesInfo, sid: FlexID) -> [EpisodeItem] {
        info.seasons.filter { $0 != "0" }.flatMap { s in (info.episodes[s] ?? []).map { EpisodeItem(season: s, ep: $0, sid: sid) } }
    }

    func progress(_ e: Episode) -> WatchProgress? { cfg?.progress?["e:" + e.id.value] }

    /// Épisode à proposer : celui en cours, sinon le suivant du dernier terminé, sinon le premier.
    func resumeTarget(_ list: [EpisodeItem]) -> (EpisodeItem, Bool)? {
        guard !list.isEmpty else { return nil }
        var last: (Int, WatchProgress)?
        for (i, e) in list.enumerated() {
            if let p = progress(e.ep), (p.ts ?? 0) > (last?.1.ts ?? -1) { last = (i, p) }
        }
        guard let found = last else { return (list[0], false) }
        let (i, p) = found
        if p.done != true { return (list[i], true) }
        var k = i + 1
        while k < list.count, progress(list[k].ep)?.done == true { k += 1 }
        return k < list.count ? (list[k], false) : nil
    }

    func playEpisode(_ x: Series, _ e: EpisodeItem, queue: [EpisodeItem], fromStart: Bool = false) async {
        guard let st: StreamInfo = try? await Engine.shared.call("/api/stream", ["type": "episode", "id": e.ep.id.json, "ext": e.ep.ext ?? "mkv", "title": x.t]) else {
            toast = "Cet épisode ne répond pas pour le moment"; return
        }
        let p = progress(e.ep)
        let start = fromStart || p?.done == true ? 0 : (p?.pos ?? 0)
        let item = PlayerViewController.Item(title: title(x), subtitle: e.label, live: false,
                                             sources: [.init(url: st.url, label: "Épisode", id: e.ep.id)], start: start > 30 ? start : 0)
        PlayerPresenter.present(item) { [weak self] ev in self?.episodeEvent(ev, series: x, ep: e, queue: queue) }
    }

    private func episodeEvent(_ ev: PlayerViewController.Event, series x: Series, ep e: EpisodeItem, queue: [EpisodeItem]) {
        switch ev {
        case .progress(let pos, let dur, _), .closed(let pos, let dur, _):
            guard dur > 0 else { break }
            let done = pos / dur > 0.94
            if case .progress = ev, pos < 5 { break }
            var body: [String: Any] = ["id": "e:" + e.ep.id.value, "kind": "series", "key": x.k, "label": e.label,
                                       "ep": ["id": e.ep.id.json, "ext": e.ep.ext ?? "mkv", "sid": e.sid.json],
                                       "pos": pos, "dur": dur, "vid": e.ep.id.json]
            if done { body["clear"] = true }
            Task {
                _ = try? await Engine.shared.data("/api/progress", body)
                if case .closed = ev {
                    _ = try? await Engine.shared.data("/api/player_closed", [:])
                    await reloadConfig()
                    await loadUpNext()
                    // épisode fini jusqu'au bout : on enchaîne sur le suivant
                    if done, let next = queue.first {
                        toast = "Épisode suivant : \(next.label)"
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        await playEpisode(x, next, queue: Array(queue.dropFirst()))
                    }
                }
            }
        }
    }

    /// « À suivre » depuis l'accueil.
    func playUpNext(_ u: UpNext) async {
        guard let x = seriesIdx[u.key] else { return }
        if let r = await loadSeries(x) {
            let list = episodes(r.1, sid: r.0)
            if let i = list.firstIndex(where: { $0.ep.id == u.ep.id }) {
                await playEpisode(x, list[i], queue: Array(list.dropFirst(i + 1).prefix(40)))
                return
            }
        }
        toast = "Épisode introuvable sur cette source"
    }

    // MARK: - Direct

    func logo(_ ch: Channel) -> URL? { TMDBImage.url(ch.p, size: "w185") }

    func loadLiveNow() async {
        guard let n: LiveNow = try? await Engine.shared.call("/api/live_now") else { return }
        liveNow = n.now ?? [:]
    }

    /// Programme en cours : guide du moteur, sinon le petit guide de la chaîne (demandé à l'affichage).
    func current(_ ch: Channel) -> (String, Double)? {
        let t = Date().timeIntervalSince1970
        if let p = liveNow[ch.k], let s = p.s, let e = p.e, s <= t, t < e, let title = p.t { return (title, (t - s) / (e - s)) }
        if let l = epg[ch.k]?.first(where: { $0.start <= t && t < $0.end }) { return (l.title, (t - l.start) / (l.end - l.start)) }
        return nil
    }

    func next(_ ch: Channel) -> EpgItem? {
        let t = Date().timeIntervalSince1970
        return epg[ch.k]?.first { $0.start > t }
    }

    func loadEpg(_ ch: Channel) async {
        guard !epgAsked.contains(ch.k), let sid = ch.s.first?.id else { return }
        epgAsked.insert(ch.k)
        if let l: [EpgItem] = try? await Engine.shared.call("/api/epg?id=" + sid.value) { epg[ch.k] = l }
    }

    func playChannel(_ ch: Channel) async {
        // lecteur Apple pour le HLS (.m3u8) quand le fournisseur le propose ; VLC sinon, et en secours
        var hls: String?
        if let st: StreamInfo = try? await Engine.shared.call("/api/stream", ["type": "live", "id": ch.s[0].id.json, "fmt": "m3u8", "title": ch.t]),
           st.url.lowercased().contains(".m3u8") {
            hls = st.url
        }
        var sources: [PlayerViewController.Source] = []
        for s in ch.s.prefix(4) {
            if let st: StreamInfo = try? await Engine.shared.call("/api/stream", ["type": "live", "id": s.id.json, "title": ch.t]) {
                sources.append(.init(url: st.url, label: (s.q ?? "").isEmpty ? "Source" : s.q!, id: s.id))
            }
        }
        guard hls != nil || !sources.isEmpty else { toast = "Cette chaîne ne répond pas pour le moment"; return }
        let sub = current(ch)?.0 ?? "En direct"
        let item = PlayerViewController.Item(title: ch.t, subtitle: sub, live: true, sources: sources, start: 0)
        let closed: () -> Void = { Task { _ = try? await Engine.shared.data("/api/player_closed", [:]) } }
        if let u = hls, let url = URL(string: u) {
            LivePlayer.present(url: url, title: ch.t, subtitle: sub, onClose: closed) { [weak self] in
                // le lecteur Apple n'a pas pu lire ce flux : VLC prend le relais
                guard !sources.isEmpty else { self?.toast = "Cette chaîne ne répond pas pour le moment"; closed(); return }
                PlayerPresenter.present(item) { ev in if case .closed = ev { closed() } }
            }
        } else {
            PlayerPresenter.present(item) { ev in if case .closed = ev { closed() } }
        }
    }
}

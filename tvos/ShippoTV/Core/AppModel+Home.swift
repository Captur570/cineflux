import Foundation

/// Accueil complet (comme sur PC, télé et iPad) : à la une en direct, ce soir, recommandations, tops de la semaine.
extension AppModel {

    /// Direct et soirée rechargés régulièrement (le moteur garde ses propres caches de quelques minutes).
    func startTVLoop() {
        guard !tvStarted else { return }
        tvStarted = true
        Task {
            await loadForYou()
            while true {
                await loadLiveNow()
                await loadTonight()
                try? await Task.sleep(nanoseconds: 240_000_000_000)
            }
        }
    }

    func loadTonight() async {
        guard let t: Tonight = try? await Engine.shared.call("/api/tonight") else { return }
        let now = Date().timeIntervalSince1970
        tonight = t.items.filter { liveIdx[$0.key] != nil && $0.end > now }
    }

    func loadForYou() async {
        guard let f: ForYou = try? await Engine.shared.call("/api/for_you") else { return }
        forYou = f.rows
    }

    /// Une affiche de l'accueil : film ou série.
    enum Poster: Hashable, Identifiable {
        case movie(Movie), series(Series)
        var id: String { switch self { case .movie(let m): return "m:" + m.k; case .series(let x): return "t:" + x.k } }
    }

    func resolve(_ kind: String, _ key: String) -> Poster? {
        if kind == "movie" { return movie(key).map { .movie($0) } }
        return seriesIdx[key].map { .series($0) }
    }

    /// « Recommandé pour vous » (profil) : films et séries mêlés.
    var recommended: [Poster] {
        guard let mix = forYou.first(where: { $0.mixed != nil })?.mixed else { return [] }
        return mix.compactMap { resolve($0.kind, $0.key) }
    }

    /// « Parce que vous avez aimé… »
    var becauseRows: [(String, [Poster])] {
        forYou.compactMap { r in
            guard let keys = r.keys, let kind = r.kind, let t = r.title else { return nil }
            let items = keys.compactMap { resolve(kind, $0) }
            return items.count >= 4 ? (t, items) : nil
        }
    }

    /// Ma liste : films et séries, dans l'ordre d'ajout.
    var myList: [Poster] {
        (cfg?.favs ?? []).compactMap { f in
            guard let i = f.firstIndex(of: ":") else { return nil }
            let kind = String(f[..<i]), key = String(f[f.index(after: i)...])
            return kind == "live" ? nil : resolve(kind, key)
        }
    }

    /// Tops et thèmes de la semaine, films et séries alternés (même ordre que sur PC et télé).
    struct DiscRow: Identifiable { let id: String; let title: String; let items: [Poster]; let ranked: Bool }

    var homeDiscover: [DiscRow] {
        let order: [(String, String)] = [("movie", "trend"), ("series", "trend"), ("movie", "blockbusters"), ("movie", "top12"), ("series", "top12"),
            ("movie", "popular"), ("series", "popular"), ("movie", "new"), ("series", "fr"), ("movie", "fr"), ("series", "new"),
            ("movie", "action"), ("series", "crime"), ("movie", "comedy"), ("movie", "family"), ("series", "scifi"), ("movie", "scifi"),
            ("movie", "thriller"), ("series", "comedy"), ("movie", "horror"), ("series", "anime"), ("movie", "classics"), ("series", "classics")]
        var out: [DiscRow] = []
        for (kind, id) in order {
            guard let r = (kind == "movie" ? discover : seriesDiscover).first(where: { $0.id == id }) else { continue }
            let top = id == "trend"
            let items: [Poster] = kind == "movie" ? movies(for: r).map { .movie($0) } : series(for: r).map { .series($0) }
            guard items.count >= 3 else { continue }
            out.append(DiscRow(id: kind + id, title: top ? "Top 10 des \(kind == "movie" ? "films" : "séries") cette semaine" : r.title,
                               items: Array(items.prefix(top ? 10 : 30)), ranked: top))
        }
        return out
    }

    /// Chaînes de l'accueil : favorites, sinon chaînes locales.
    var homeChannels: [Channel] {
        let favs = favChannels
        if !favs.isEmpty { return Array(favs.prefix(24)) }
        return Array((catalog?.live ?? []).filter { ($0.loc ?? 0) > 0 }.prefix(24))
    }

    /// Mise en avant du direct : un match avec écussons, sinon du sport, sinon le premier programme.
    var featuredLive: TVEvent? {
        let now = Date().timeIntervalSince1970
        let evs = liveEvents.filter { $0.end > now }
        return evs.first { ($0.teams ?? []).count == 2 && ($0.teams ?? []).allSatisfy { $0.b != nil } } ?? evs.first { $0.tag == "Sport" } ?? evs.first
    }

    var featuredTonight: TVEvent? {
        let now = Date().timeIntervalSince1970
        let tn = tonight.filter { $0.end > now && $0.key != featuredLive?.key }
        return tn.first { $0.start > now } ?? tn.first
    }

    /// Programme (en direct ou ce soir) choisi : regarder s'il a commencé, sinon proposer un rappel.
    func open(_ ev: TVEvent) async {
        let now = Date().timeIntervalSince1970
        guard let ch = liveIdx[ev.key] else { return }
        if ev.start <= now { await playChannel(ch); return }
        let has = hasReminder(ev.key, ev.start)
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        let c = await ask(ev.title, "\(ev.ch), \(f.string(from: Date(timeIntervalSince1970: ev.start)))" + ((ev.desc ?? "").isEmpty ? "" : "\n\n" + (ev.desc ?? "")), [
            Choice(title: has ? "Supprimer le rappel" : "Me rappeler à \(f.string(from: Date(timeIntervalSince1970: ev.start)))", style: .default, value: 1),
            Choice(title: "Regarder \(ev.ch) maintenant", style: .default, value: 2),
            Choice(title: "Annuler", style: .cancel, value: 0),
        ])
        if c == 1 { await toggleReminder(key: ev.key, ch: ev.ch, prog: GuideProg(title: ev.title, desc: ev.desc, start: ev.start, end: ev.end, tag: ev.tag)) }
        if c == 2 { await playChannel(ch) }
    }
}

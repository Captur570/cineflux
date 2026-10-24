import SwiftUI

/// Affiche d'une série (ouvre sa fiche).
struct SeriesCard: View {
    @EnvironmentObject var model: AppModel
    let series: Series
    var width: CGFloat = 250

    var body: some View {
        NavigationLink(value: series) {
            RemoteImage(url: model.poster(series), title: model.title(series))
                .frame(width: width, height: width * 1.5)
        }
        .buttonStyle(.card)
        .contextMenu {
            Button(model.isFav("series", series.k) ? "Retirer de Ma liste" : "Ajouter à Ma liste") {
                Task { await model.toggleFav("series", series.k) }
            }
        }
        .accessibilityLabel(model.title(series))
    }
}

struct SeriesRowView: View {
    @EnvironmentObject var model: AppModel
    let title: String
    let items: [Series]
    var limit = 40

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title).font(.system(size: 34, weight: .bold)).padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 40) {
                    ForEach(Array(items.prefix(limit))) { SeriesCard(series: $0) }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
        .onAppear { model.want(series: Array(items.prefix(limit))) }
    }
}

/// « À suivre » : prochain épisode des séries en cours (lecture directe).
struct UpNextRow: View {
    @EnvironmentObject var model: AppModel
    let items: [UpNext]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("À suivre").font(.system(size: 34, weight: .bold)).padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 40) {
                    ForEach(items) { u in
                        if let x = model.seriesIdx[u.key] {
                            Button { Task { await model.playUpNext(u) } } label: {
                                ZStack(alignment: .bottomLeading) {
                                    RemoteImage(url: TMDBImage.url(u.img, size: "w780") ?? model.backdrop(x, large: false) ?? model.poster(x), title: model.title(x))
                                    LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(model.title(x)).font(.system(size: 26, weight: .bold)).lineLimit(1)
                                        Text(u.sub ?? u.label ?? "").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.muted).lineLimit(1)
                                        if let d = u.dur, d > 0, let p = u.pos, p > 0 { ProgressBar(value: p / d) }
                                    }
                                    .padding(18)
                                }
                                .frame(width: 460, height: 258)
                            }
                            .buttonStyle(.card)
                        }
                    }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
    }
}

/// Onglet Séries : tendances puis catégories.
struct SeriesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 30) {
                Text("Séries").font(.system(size: 60, weight: .heavy)).padding(.leading, 80).padding(.top, 30)
                Text("\(model.catalog?.series.count ?? 0) séries disponibles")
                    .font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.muted).padding(.leading, 80)
                if !model.upNext.isEmpty { UpNextRow(items: model.upNext) }
                let favs = model.favSeries
                if !favs.isEmpty { SeriesRowView(title: "Mes séries", items: favs) }
                SeriesRowView(title: "Ajoutées récemment", items: model.recentSeries, limit: 30)
                ForEach(model.seriesDiscover, id: \.self) { row in
                    let items = model.series(for: row)
                    if items.count >= 3 { SeriesRowView(title: row.title, items: items) }
                }
                ForEach(model.seriesRows) { row in
                    SeriesRowView(title: row.title, items: row.items, limit: 200)
                }
            }
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
    }
}

/// Fiche d'une série : résumé, Lecture / Reprendre / Épisode suivant, saisons et épisodes.
struct SeriesDetailView: View {
    @EnvironmentObject var model: AppModel
    let series: Series
    @State private var info: SeriesInfo?
    @State private var sid: FlexID?
    @State private var season: String?
    @State private var source = 0
    @State private var loading = true

    var body: some View {
        let m = model.meta["t:" + series.k]
        let list = info.flatMap { i in sid.map { model.episodes(i, sid: $0) } } ?? []
        let target = model.resumeTarget(list)
        ZStack(alignment: .topLeading) {
            RemoteImage(url: model.backdrop(series), title: "", showTitle: false)
                .ignoresSafeArea()
                .overlay(LinearGradient(colors: [Theme.bg.opacity(0.95), Theme.bg.opacity(0.6), Theme.bg.opacity(0.15)], startPoint: .leading, endPoint: .trailing).ignoresSafeArea())
                .overlay(LinearGradient(colors: [.clear, Theme.bg], startPoint: .center, endPoint: .bottom).ignoresSafeArea())
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 26) {
                    Spacer().frame(height: 120)
                    Text(model.title(series)).font(.system(size: 80, weight: .heavy)).lineLimit(2).frame(maxWidth: 1300, alignment: .leading)
                    HStack(spacing: 16) {
                        if let y = series.y { Text(String(y)) }
                        if let i = info { Text(i.seasons.filter { $0 != "0" }.count > 1 ? "\(i.seasons.filter { $0 != "0" }.count) saisons" : "1 saison") }
                        if let v = m?.v, v > 0 { Badge(text: String(format: "★ %.1f", v)) }
                        if let g = m?.g, !g.isEmpty { Text(g.prefix(3).joined(separator: " · ")) }
                    }
                    .font(.system(size: 28, weight: .semibold)).foregroundStyle(Theme.muted)
                    Text(m?.o ?? info?.info?.plot ?? series.pl ?? "")
                        .font(.system(size: 28)).foregroundStyle(.white.opacity(0.88)).lineLimit(5).frame(maxWidth: 1150, alignment: .leading)
                    HStack(spacing: 26) {
                        if let t = target {
                            let started = list.contains { model.progress($0.ep) != nil }
                            Button { Task { await play(t.0, list) } } label: {
                                Label(t.1 ? "Reprendre \(t.0.short)" : (started ? "Épisode suivant \(t.0.short)" : "Lecture \(t.0.short)"), systemImage: "play.fill")
                                    .font(.system(size: 30, weight: .bold)).padding(.horizontal, 24)
                            }
                        } else if loading {
                            ProgressView().padding(.horizontal, 40)
                        }
                        if let t = target, Infuse.installed && !Infuse.always {
                            Button { Task { await model.playEpisode(series, t.0, queue: [], infuse: true) } } label: {
                                Label("Infuse", systemImage: "arrow.up.forward.app").font(.system(size: 28, weight: .semibold))
                            }
                        }
                        Button { Task { await model.toggleFav("series", series.k) } } label: {
                            Label(model.isFav("series", series.k) ? "Dans ma liste" : "Ma liste", systemImage: model.isFav("series", series.k) ? "checkmark" : "plus")
                                .font(.system(size: 28, weight: .semibold))
                        }
                        if series.s.count > 1 {
                            Button { Task { await switchSource() } } label: {
                                Label("Source \(source + 1)/\(series.s.count)", systemImage: "arrow.triangle.2.circlepath").font(.system(size: 26, weight: .semibold))
                            }
                        }
                    }
                    .padding(.top, 6)
                    if let i = info {
                        seasonsBar(i, current: season ?? target?.0.season ?? i.seasons.first ?? "1")
                        episodesRow(i, season: season ?? target?.0.season ?? i.seasons.first ?? "1", all: list)
                    } else if !loading {
                        Text("Aucun épisode disponible sur cette source pour le moment.")
                            .font(.system(size: 26)).foregroundStyle(Theme.muted).padding(.top, 30)
                    }
                }
                .padding(.horizontal, 80)
                .padding(.bottom, 80)
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        if let r = await model.loadSeries(series, source: source) {
            sid = r.0
            info = r.1
            if let i = series.s.firstIndex(where: { $0.id == r.0 }) { source = i }
        }
        loading = false
    }

    private func switchSource() async {
        source = (source + 1) % series.s.count
        info = nil
        season = nil
        await load()
    }

    private func play(_ e: EpisodeItem, _ list: [EpisodeItem]) async {
        let i = list.firstIndex(of: e) ?? 0
        await model.playEpisode(series, e, queue: Array(list.dropFirst(i + 1).prefix(40)))
    }

    private func seasonsBar(_ i: SeriesInfo, current: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 20) {
                ForEach(i.seasons, id: \.self) { s in
                    Button { season = s } label: {
                        Text(s == "0" ? "Bonus" : "Saison \(s)")
                            .font(.system(size: 26, weight: s == current ? .heavy : .semibold))
                            .foregroundStyle(s == current ? .white : Theme.muted)
                            .padding(.horizontal, 10)
                    }
                }
            }
            .padding(.vertical, 20)
            .padding(.horizontal, 4)
        }
        .scrollClipDisabled()
        .padding(.top, 30)
    }

    private func episodesRow(_ i: SeriesInfo, season s: String, all: [EpisodeItem]) -> some View {
        let eps = (i.episodes[s] ?? []).map { EpisodeItem(season: s, ep: $0, sid: sid ?? FlexID("0")) }
        return ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 36) {
                    ForEach(eps, id: \.self) { e in
                        EpisodeCard(series: series, item: e) { Task { await playFromList(e, all: all, season: eps) } }
                            .id(e.ep.id.value)
                    }
                }
                .padding(.vertical, 24)
                .padding(.horizontal, 4)
            }
            .scrollClipDisabled()
            .onAppear {
                // ouvrir la rangée sur l'épisode à reprendre
                if let t = model.resumeTarget(all)?.0, t.season == s { proxy.scrollTo(t.ep.id.value, anchor: .leading) }
            }
        }
    }

    private func playFromList(_ e: EpisodeItem, all: [EpisodeItem], season: [EpisodeItem]) async {
        let list = all.contains(e) ? all : season
        let i = list.firstIndex(of: e) ?? 0
        await model.playEpisode(series, e, queue: Array(list.dropFirst(i + 1).prefix(40)))
    }
}

struct EpisodeCard: View {
    @EnvironmentObject var model: AppModel
    let series: Series
    let item: EpisodeItem
    let action: () -> Void

    var body: some View {
        let p = model.progress(item.ep)
        VStack(alignment: .leading, spacing: 14) {
            Button(action: action) {
                ZStack(alignment: .bottomLeading) {
                    RemoteImage(url: TMDBImage.url(item.ep.img, size: "w780") ?? model.backdrop(series, large: false), title: "", showTitle: false)
                    if p?.done == true {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 34)).symbolRenderingMode(.palette).foregroundStyle(.white, Theme.wine)
                            .padding(14).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    }
                    if let p, p.done != true, let d = p.dur, d > 0 { ProgressBar(value: (p.pos ?? 0) / d).padding(14) }
                }
                .frame(width: 420, height: 236)
            }
            .buttonStyle(.card)
            Text(item.short + (item.ep.t.isEmpty || item.ep.t.hasPrefix("Épisode ") ? "" : "  " + item.ep.t))
                .font(.system(size: 24, weight: .bold)).lineLimit(1)
            Text([item.ep.dur.flatMap(duration), item.ep.plot].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.system(size: 20)).foregroundStyle(Theme.muted).lineLimit(3)
        }
        .frame(width: 420, alignment: .leading)
    }

    private func duration(_ d: String) -> String? {
        let parts = d.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 2 else { return d.isEmpty ? nil : d }
        let mins = parts.count == 3 ? parts[0] * 60 + parts[1] : parts[0]
        return mins > 0 ? "\(mins) min" : nil
    }
}

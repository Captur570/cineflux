import SwiftUI

/// Affiche d'un film ou d'une série (rangées mêlées de l'accueil).
struct MixedCard: View {
    @EnvironmentObject var model: AppModel
    let item: AppModel.Poster
    var body: some View {
        switch item {
        case .movie(let m): PosterCard(movie: m)
        case .series(let x): SeriesCard(series: x)
        }
    }
}

/// Rangée mêlée films + séries ; « ranked » : grand numéro devant chaque affiche (Top 10).
struct MixedRow: View {
    @EnvironmentObject var model: AppModel
    let title: String
    let items: [AppModel.Poster]
    var ranked = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title).font(.system(size: 34, weight: .bold)).padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .bottom, spacing: ranked ? 20 : 40) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { i, it in
                        if ranked {
                            HStack(alignment: .bottom, spacing: -18) {
                                Text("\(i + 1)")
                                    .font(.system(size: 190, weight: .black))
                                    .foregroundStyle(.white.opacity(0.14))
                                    .frame(width: i + 1 >= 10 ? 210 : 120, alignment: .trailing)
                                    .offset(y: 30)
                                MixedCard(item: it)
                            }
                            .padding(.trailing, 20)
                        } else {
                            MixedCard(item: it)
                        }
                    }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
        .onAppear {
            model.want(items.compactMap { if case .movie(let m) = $0 { return m } else { return nil } })
            model.want(series: items.compactMap { if case .series(let x) = $0 { return x } else { return nil } })
        }
    }
}

/// « Continuer à regarder » : films commencés et épisodes (commencés ou suivants), du plus récent au plus ancien.
struct ContinueRow: View {
    @EnvironmentObject var model: AppModel

    private enum Entry: Identifiable {
        case movie(AppModel.ResumeEntry), episode(UpNext)
        var id: String { switch self { case .movie(let e): return "m:" + e.movie.k; case .episode(let u): return u.pid } }
        var ts: Double { switch self { case .movie(let e): return e.progress.ts ?? 0; case .episode(let u): return u.ts ?? 0 } }
    }

    var body: some View {
        let entries = (model.resumeMovies.map { Entry.movie($0) } + model.upNext.map { Entry.episode($0) }).sorted { $0.ts > $1.ts }
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 18) {
                Text("Continuer à regarder").font(.system(size: 34, weight: .bold)).padding(.leading, 80)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 40) {
                        ForEach(entries) { e in
                            switch e {
                            case .movie(let r):
                                card(url: model.backdrop(r.movie, large: false) ?? model.poster(r.movie), title: model.title(r.movie),
                                     sub: remaining(r.progress), prog: (r.progress.pos ?? 0) / max(1, r.progress.dur ?? 1)) {
                                    Task { await model.play(r.movie) }
                                }
                            case .episode(let u):
                                if let x = model.seriesIdx[u.key] {
                                    card(url: TMDBImage.url(u.img, size: "w780") ?? model.backdrop(x, large: false) ?? model.poster(x), title: model.title(x),
                                         sub: (u.next == true ? "Épisode suivant · " : "") + (u.sub ?? u.label ?? ""),
                                         prog: (u.dur ?? 0) > 0 ? (u.pos ?? 0) / (u.dur ?? 1) : nil) {
                                        Task { await model.playUpNext(u) }
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 80)
                    .padding(.vertical, 30)
                }
                .scrollClipDisabled()
            }
            .onAppear {
                model.want(model.resumeMovies.map(\.movie))
                model.want(series: model.upNext.compactMap { model.seriesIdx[$0.key] })
            }
        }
    }

    private func card(url: URL?, title: String, sub: String, prog: Double?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack(alignment: .bottomLeading) {
                RemoteImage(url: url, title: title)
                LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(.system(size: 26, weight: .bold)).lineLimit(1)
                    Text(sub).font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.muted).lineLimit(1)
                    if let p = prog, p > 0 { ProgressBar(value: p) }
                }
                .padding(18)
            }
            .frame(width: 460, height: 258)
        }
        .buttonStyle(.card)
    }

    private func remaining(_ p: WatchProgress) -> String {
        let left = max(0, (p.dur ?? 0) - (p.pos ?? 0))
        let m = Int(left / 60)
        return m >= 60 ? "Encore \(m / 60) h \(String(format: "%02d", m % 60))" : "Encore \(m) min"
    }
}

/// Carte d'un programme : match (écussons), film du soir (image TMDB) ou logo de la chaîne.
struct EventCard: View {
    @EnvironmentObject var model: AppModel
    let ev: TVEvent
    var width: CGFloat = 460

    var body: some View {
        let now = Date().timeIntervalSince1970
        let started = ev.start <= now
        Button { Task { await model.open(ev) } } label: {
            ZStack(alignment: .bottomLeading) {
                LinearGradient(colors: [Theme.hue(ev.title), Theme.hue(ev.title).opacity(0.35), Theme.bg], startPoint: .topLeading, endPoint: .bottomTrailing)
                if let teams = ev.teams, teams.count == 2 {
                    // écussons en haut, texte en bas : rien ne se chevauche
                    VStack {
                        HStack(alignment: .top, spacing: 18) {
                            teamView(teams[0])
                            Text("VS").font(.system(size: 26, weight: .black)).foregroundStyle(.white.opacity(0.7))
                                .fixedSize().padding(.top, 24)
                            teamView(teams[1])
                        }
                        .padding(.top, 14)
                        Spacer()
                    }
                    .frame(maxWidth: .infinity)
                } else if let u = TMDBImage.url(ev.img, size: "w780") ?? TMDBImage.url(ev.poster, size: "w342") {
                    RemoteImage(url: u, title: "", showTitle: false)
                } else if let l = TMDBImage.url(ev.logo, size: "w185") {
                    VStack { RemoteImage(url: l, title: "", showTitle: false, fit: true).frame(height: width * 0.3); Spacer() }
                }
                LinearGradient(colors: [.clear, .black.opacity(0.92)], startPoint: UnitPoint(x: 0.5, y: 0.45), endPoint: .bottom)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        if started { Circle().fill(Theme.wine).frame(width: 12, height: 12) }
                        Text("\(started ? "En direct" : hm(ev.start)) · \(ev.ch)").font(.system(size: 19, weight: .bold)).foregroundStyle(Theme.accent2).lineLimit(1)
                        if model.hasReminder(ev.key, ev.start) { Image(systemName: "bell.fill").font(.system(size: 18)).foregroundStyle(Theme.accent2) }
                    }
                    Text(ev.title).font(.system(size: 24, weight: .bold)).lineLimit(1)
                    if started { ProgressBar(value: min(1, (now - ev.start) / max(1, ev.end - ev.start))) }
                    else {
                        Text([ev.tag, ev.year.map(String.init), ev.vote.map { String(format: "★ %.1f", $0) }].compactMap { $0 }.joined(separator: " · "))
                            .font(.system(size: 18)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                .padding(16)
            }
            .frame(width: width, height: width * 0.56)
        }
        .buttonStyle(.card)
    }

    private func teamView(_ t: Team) -> some View {
        let side = width * 0.17
        return VStack(spacing: 6) {
            if let u = TMDBImage.url(t.b, size: "w185") {
                RemoteImage(url: u, title: "", showTitle: false, fit: true).frame(width: side, height: side)
            } else {
                Text(String(t.n.prefix(3)).uppercased()).font(.system(size: side * 0.32, weight: .black)).frame(width: side, height: side)
                    .background(Color.white.opacity(0.12), in: Circle())
            }
            Text(t.n).font(.system(size: 16, weight: .bold)).lineLimit(1).frame(width: width * 0.32)
        }
    }

    private func hm(_ t: Double) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: t))
    }
}

struct EventRow: View {
    let title: String
    let icon: String
    let items: [TVEvent]
    var live = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(title, systemImage: icon).font(.system(size: 34, weight: .bold)).padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 40) {
                    ForEach(items) { EventCard(ev: $0) }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
    }
}

/// Tuiles posées sur la mise en avant : un programme en direct (match si possible) et ce soir.
struct SideTiles: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .trailing, spacing: 24) {
            if let l = model.featuredLive { EventCard(ev: l, width: 420) }
            if let t = model.featuredTonight { EventCard(ev: t, width: 420) }
        }
    }
}

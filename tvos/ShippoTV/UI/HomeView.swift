import SwiftUI

/// Accueil : grande mise en avant, puis Reprendre, Ma liste, tendances et catégories.
struct HomeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 30) {
                if let f = model.featured {
                    Hero(movie: f).id("top")
                        .overlay(alignment: .bottomTrailing) { SideTiles().padding(.trailing, 80).padding(.bottom, 40) }
                }
                if model.cfg?.has_tmdb != true { TMDBHint().padding(.horizontal, 80) }
                ContinueRow()
                let rec = model.recommended
                if rec.count >= 5 {
                    MixedRow(title: model.cfg.map { $0.profiles.count > 1 } == true ? "Recommandé pour \(model.cfg?.profiles.first { $0.id == model.profileId }?.name ?? "vous")" : "Recommandé pour vous", items: rec)
                }
                if !model.tonight.isEmpty { EventRow(title: "Ce soir chez vous", icon: "calendar", items: model.tonight) }
                if !model.liveEvents.isEmpty { EventRow(title: "À la une en direct", icon: "dot.radiowaves.left.and.right", items: Array(model.liveEvents.prefix(16)), live: true) }
                let disc = model.homeDiscover
                let because = model.becauseRows
                ForEach(Array(disc.enumerated()), id: \.element.id) { i, row in
                    MixedRow(title: row.title, items: row.items, ranked: row.ranked).id("h:" + row.id)
                    // « Parce que vous avez aimé… » glissées entre les tops, comme sur PC et télé
                    if i % 3 == 2, i / 3 < because.count { MixedRow(title: because[i / 3].0, items: because[i / 3].1) }
                }
                let mine = model.myList
                if !mine.isEmpty { MixedRow(title: "Ma liste", items: Array(mine.prefix(30))) }
                PosterRow(title: "Ajoutés récemment chez vous", items: model.recentMovies, limit: 30)
                if !model.recentSeries.isEmpty { SeriesRowView(title: "Séries mises à jour", items: model.recentSeries, limit: 30) }
                let chans = model.homeChannels
                if !chans.isEmpty { ChannelRow(title: model.favChannels.isEmpty ? "Chaînes TV" : "Vos chaînes", items: chans) }
                if disc.isEmpty {
                    ForEach(model.categoryRows.prefix(4), id: \.id) { row in
                        PosterRow(title: row.title, items: row.items).id("c:" + row.id)
                    }
                }
            }
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
        .task {
            // essais GitHub : parcours de l'accueil comme à la télécommande (descente rangée par rangée, puis retour en haut)
            if model.test?.route == "home_top10" {
                try? await Task.sleep(nanoseconds: 9_000_000_000)
                withAnimation { proxy.scrollTo("h:movietrend", anchor: .top) }
                return
            }
            guard model.test?.route == "scroll" else { return }
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            let ids = model.homeDiscover.map { "h:" + $0.id }
            for (i, id) in ids.enumerated() {
                model.testMark = "[rangée \(i + 1)/\(ids.count)]"
                withAnimation { proxy.scrollTo(id, anchor: .top) }
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
            model.testMark = "[retour en haut]"
            withAnimation { proxy.scrollTo("top", anchor: .top) }
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            for (i, id) in ids.prefix(4).enumerated() {
                model.testMark = "[2e passage, rangée \(i + 1)]"
                withAnimation { proxy.scrollTo(id, anchor: .top) }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
            model.testMark = "[fin]"
        }
        }
    }
}

/// Mise en avant : image de fond plein écran, titre, résumé, Lecture / Plus d'infos.
struct Hero: View {
    @EnvironmentObject var model: AppModel
    let movie: Movie

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(url: model.backdrop(movie), title: "", showTitle: false)
                .frame(height: 760)
                .mask(LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom))
            LinearGradient(colors: [Theme.bg.opacity(0.9), Theme.bg.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(height: 760)
            VStack(alignment: .leading, spacing: 20) {
                Text("À LA UNE")
                    .font(.system(size: 22, weight: .heavy)).tracking(3)
                    .foregroundStyle(Theme.accent2)
                Text(model.title(movie))
                    .font(.system(size: 76, weight: .heavy))
                    .lineLimit(2)
                    .frame(maxWidth: 1100, alignment: .leading)
                HStack(spacing: 14) {
                    if let y = movie.y { Text(String(y)).font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.muted) }
                    if let v = model.meta["m:" + movie.k]?.v, v > 0 { Badge(text: String(format: "★ %.1f", v)) }
                    if let q = movie.v.first?.q, !q.isEmpty { Badge(text: q) }
                }
                if let o = model.meta["m:" + movie.k]?.o, !o.isEmpty {
                    Text(o).font(.system(size: 26)).foregroundStyle(.white.opacity(0.85)).lineLimit(3).frame(maxWidth: 1000, alignment: .leading)
                }
                HStack(spacing: 24) {
                    Button { Task { await model.play(movie) } } label: {
                        Label(model.progress(movie) == nil ? "Lecture" : "Reprendre", systemImage: "play.fill")
                            .font(.system(size: 28, weight: .bold)).padding(.horizontal, 20)
                    }
                    NavigationLink(value: movie) {
                        Label("Plus d'infos", systemImage: "info.circle").font(.system(size: 28, weight: .semibold)).padding(.horizontal, 12)
                    }
                }
                .padding(.top, 10)
            }
            .padding(.leading, 80)
            .padding(.bottom, 40)
        }
        .task { await model.fullMeta(movie) }
    }
}

/// Sans clé TMDB : pas d'affiches ni de résumés. La clé arrive avec le code de jumelage du PC.
struct TMDBHint: View {
    var body: some View {
        HStack(spacing: 20) {
            Image(systemName: "photo.on.rectangle.angled").font(.system(size: 40)).foregroundStyle(Theme.accent2)
            Text("Pas d'affiches ni de résumés : la clé TMDB n'est pas encore sur cette Apple TV. Sur le PC, Réglages › Synchronisation › Associer un appareil, cochez « Transmettre aussi mes identifiants IPTV et la clé TMDB », puis saisissez le code dans Réglages › Synchronisation.")
                .font(.system(size: 24)).foregroundStyle(.white.opacity(0.85))
        }
        .padding(28)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

/// Films : toutes les catégories en rangées.
struct MoviesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 30) {
                Text("Films")
                    .font(.system(size: 60, weight: .heavy))
                    .padding(.leading, 80).padding(.top, 30)
                Text("\(model.catalog?.movies.count ?? 0) titres disponibles")
                    .font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.muted)
                    .padding(.leading, 80)
                ForEach(model.discover, id: \.self) { row in
                    let items = model.movies(for: row)
                    if items.count >= 3 { PosterRow(title: row.title, items: items) }
                }
                ForEach(model.categoryRows, id: \.id) { row in
                    PosterRow(title: row.title, items: row.items, limit: 200)
                }
            }
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
    }
}


/// Rangée de chaînes (Ma liste, recherche).
struct ChannelRow: View {
    let title: String
    let items: [Channel]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title).font(.system(size: 34, weight: .bold)).padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 44) {
                    ForEach(items) { ChannelCard(channel: $0) }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
    }
}

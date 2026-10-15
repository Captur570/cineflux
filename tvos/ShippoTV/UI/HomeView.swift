import SwiftUI

/// Accueil : grande mise en avant, puis Reprendre, Ma liste, tendances et catégories.
struct HomeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 30) {
                if let f = model.featured { Hero(movie: f) }
                let resume = model.resumeMovies
                if !resume.isEmpty { ResumeRow(items: resume) }
                let favs = model.favMovies
                if !favs.isEmpty { PosterRow(title: "Ma liste", items: favs) }
                PosterRow(title: "Ajoutés récemment", items: model.recentMovies, limit: 30)
                ForEach(model.discover, id: \.self) { row in
                    let items = model.movies(for: row)
                    if items.count >= 3 { PosterRow(title: row.title, items: items) }
                }
                ForEach(model.categoryRows, id: \.id) { row in
                    PosterRow(title: row.title, items: row.items)
                }
            }
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
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

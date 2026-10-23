import SwiftUI

/// Onglet Recherche : clavier de l'Apple TV (et dictée Siri), résultats films, séries, chaînes.
struct SearchView: View {
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var results = AppModel.SearchResults()

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 30) {
                if query.trimmingCharacters(in: .whitespaces).count < 2 {
                    Text("Tapez au moins deux lettres d'un titre de film, de série ou d'une chaîne.")
                        .font(.system(size: 28)).foregroundStyle(Theme.muted).padding(.horizontal, 80).padding(.top, 40)
                } else if results.movies.isEmpty && results.series.isEmpty && results.live.isEmpty {
                    Text("Rien trouvé pour « \(query) ».")
                        .font(.system(size: 28)).foregroundStyle(Theme.muted).padding(.horizontal, 80).padding(.top, 40)
                } else {
                    if !results.movies.isEmpty { PosterRow(title: "Films", items: results.movies, limit: 60) }
                    if !results.series.isEmpty { SeriesRowView(title: "Séries", items: results.series, limit: 60) }
                    if !results.live.isEmpty {
                        VStack(alignment: .leading, spacing: 18) {
                            Text("Chaînes").font(.system(size: 34, weight: .bold)).padding(.leading, 80)
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(alignment: .top, spacing: 44) {
                                    ForEach(results.live.prefix(40)) { ChannelCard(channel: $0) }
                                }
                                .padding(.horizontal, 80)
                                .padding(.vertical, 30)
                            }
                            .scrollClipDisabled()
                        }
                    }
                }
            }
            .padding(.bottom, 80)
        }
        .searchable(text: $query, prompt: "Films, séries, chaînes")
        .task(id: query) {
            // petite pause pendant la frappe, puis recherche dans tout le catalogue
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let q = query.trimmingCharacters(in: .whitespaces)
            results = q.count < 2 ? AppModel.SearchResults() : model.search(q)
        }
        .onAppear { if let q = model.test?.searchQuery, query.isEmpty { query = q } }
    }
}

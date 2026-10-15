import SwiftUI

/// Une affiche de film : se soulève et brille au focus (style « carte » natif de l'Apple TV).
struct PosterCard: View {
    @EnvironmentObject var model: AppModel
    let movie: Movie
    var width: CGFloat = 250

    var body: some View {
        NavigationLink(value: movie) {
            ZStack(alignment: .bottom) {
                RemoteImage(url: model.poster(movie), title: model.title(movie))
                if let p = model.progress(movie), let d = p.dur, d > 0 {
                    ProgressBar(value: (p.pos ?? 0) / d).padding(12)
                }
            }
            .frame(width: width, height: width * 1.5)
        }
        .buttonStyle(.card)
        .accessibilityLabel(model.title(movie))
    }
}

struct ProgressBar: View {
    let value: Double
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.28))
                Capsule().fill(Theme.wine).frame(width: max(6, g.size.width * min(1, max(0, value))))
            }
        }
        .frame(height: 6)
    }
}

/// Une rangée horizontale d'affiches avec son titre.
struct PosterRow: View {
    @EnvironmentObject var model: AppModel
    let title: String
    let items: [Movie]
    var limit = 40

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title)
                .font(.system(size: 34, weight: .bold))
                .padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 40) {
                    ForEach(Array(items.prefix(limit))) { m in
                        PosterCard(movie: m)
                    }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
        .onAppear { model.want(Array(items.prefix(limit))) }
    }
}

/// Rangée « Reprendre » : vignettes larges avec la progression.
struct ResumeRow: View {
    @EnvironmentObject var model: AppModel
    let items: [AppModel.ResumeEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Reprendre")
                .font(.system(size: 34, weight: .bold))
                .padding(.leading, 80)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 40) {
                    ForEach(items) { e in
                        let m = e.movie, p = e.progress
                        Button {
                            Task { await model.play(m) }
                        } label: {
                            ZStack(alignment: .bottomLeading) {
                                RemoteImage(url: model.backdrop(m, large: false) ?? model.poster(m), title: model.title(m))
                                LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(model.title(m)).font(.system(size: 26, weight: .bold)).lineLimit(1)
                                    Text(remaining(p)).font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.muted)
                                    ProgressBar(value: (p.pos ?? 0) / max(1, p.dur ?? 1))
                                }
                                .padding(18)
                            }
                            .frame(width: 460, height: 258)
                        }
                        .buttonStyle(.card)
                    }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
        .onAppear { model.want(items.map(\.movie)) }
    }

    private func remaining(_ p: WatchProgress) -> String {
        let left = max(0, (p.dur ?? 0) - (p.pos ?? 0))
        let m = Int(left / 60)
        return m >= 60 ? "Encore \(m / 60) h \(String(format: "%02d", m % 60))" : "Encore \(m) min"
    }
}

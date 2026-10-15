import SwiftUI

/// Fiche d'un film : image de fond, informations, Lecture / Reprendre, Ma liste, versions.
struct MovieDetailView: View {
    @EnvironmentObject var model: AppModel
    let movie: Movie

    var body: some View {
        let m = model.meta["m:" + movie.k]
        let info = model.info[movie.k]
        let prog = model.progress(movie)
        ZStack(alignment: .topLeading) {
            RemoteImage(url: model.backdrop(movie), title: "", showTitle: false)
                .ignoresSafeArea()
                .overlay(LinearGradient(colors: [Theme.bg.opacity(0.95), Theme.bg.opacity(0.6), Theme.bg.opacity(0.15)], startPoint: .leading, endPoint: .trailing).ignoresSafeArea())
                .overlay(LinearGradient(colors: [.clear, Theme.bg], startPoint: .center, endPoint: .bottom).ignoresSafeArea())
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 26) {
                    Spacer().frame(height: 120)
                    Text(model.title(movie))
                        .font(.system(size: 80, weight: .heavy))
                        .lineLimit(2)
                        .frame(maxWidth: 1300, alignment: .leading)
                    HStack(spacing: 16) {
                        if let y = movie.y { Text(String(y)) }
                        if let rt = m?.rt, rt > 0 { Text("\(rt / 60) h \(String(format: "%02d", rt % 60))") }
                        else if let d = info?.duration, !d.isEmpty { Text(d) }
                        if let v = m?.v, v > 0 { Badge(text: String(format: "★ %.1f", v)) }
                        if let g = m?.g, !g.isEmpty { Text(g.prefix(3).joined(separator: " · ")) }
                    }
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(Theme.muted)
                    Text(m?.o ?? info?.plot ?? "Chargement du résumé…")
                        .font(.system(size: 28))
                        .foregroundStyle(.white.opacity(0.88))
                        .lineLimit(6)
                        .frame(maxWidth: 1150, alignment: .leading)
                    HStack(spacing: 26) {
                        Button { Task { await model.play(movie) } } label: {
                            Label(prog.map { "Reprendre à \(clock($0.pos ?? 0))" } ?? "Lecture", systemImage: "play.fill")
                                .font(.system(size: 30, weight: .bold)).padding(.horizontal, 24)
                        }
                        if prog != nil {
                            Button { Task { await model.play(movie, fromStart: true) } } label: {
                                Label("Depuis le début", systemImage: "backward.end.fill").font(.system(size: 28, weight: .semibold))
                            }
                        }
                        Button { Task { await model.toggleFav(movie) } } label: {
                            Label(model.isFav(movie) ? "Dans ma liste" : "Ma liste", systemImage: model.isFav(movie) ? "checkmark" : "plus")
                                .font(.system(size: 28, weight: .semibold))
                        }
                    }
                    .padding(.top, 6)
                    if let i = info {
                        VStack(alignment: .leading, spacing: 10) {
                            if let d = i.director, !d.isEmpty { infoLine("Réalisation", d) }
                            if let c = i.cast, !c.isEmpty { infoLine("Avec", c.split(separator: ",").prefix(5).joined(separator: ",")) }
                        }
                        .padding(.top, 10)
                    }
                    Text(movie.v.count > 1 ? "\(movie.v.count) versions disponibles" : "Version disponible")
                        .font(.system(size: 34, weight: .bold))
                        .padding(.top, 30)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 30) {
                            ForEach(model.playOrder(movie, first: nil), id: \.self) { v in
                                Button { Task { await model.play(movie, version: v) } } label: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(model.versionLabel(v)).font(.system(size: 28, weight: .bold))
                                        Text(v.n ?? "").font(.system(size: 20)).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    .frame(width: 460, alignment: .leading)
                                    .padding(.vertical, 8)
                                }
                            }
                        }
                        .padding(.vertical, 24)
                        .padding(.horizontal, 4)
                    }
                    .scrollClipDisabled()
                }
                .padding(.horizontal, 80)
                .padding(.bottom, 80)
            }
        }
        .task { await model.fullMeta(movie) }
    }

    private func infoLine(_ k: String, _ v: String) -> some View {
        (Text(k + "  ").foregroundColor(Theme.muted) + Text(v))
            .font(.system(size: 24))
            .lineLimit(1)
    }

    private func clock(_ s: Double) -> String {
        let t = Int(s)
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}

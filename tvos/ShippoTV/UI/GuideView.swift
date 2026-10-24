import SwiftUI

/// Guide des programmes : une ligne par chaîne, de l'heure passée à +6 h.
/// Programme en cours → regarder ; programme à venir → me rappeler (rappel synchronisé).
struct GuideView: View {
    @EnvironmentObject var model: AppModel
    @State private var picked: (GuideRow, GuideProg)?
    @State private var showPick = false

    private let pxPerMin: CGFloat = 9
    private let rowH: CGFloat = 104
    private let nameW: CGFloat = 250

    var body: some View {
        Group {
            if let g = model.guide, !g.rows.isEmpty {
                grid(g)
            } else if model.guide != nil {
                Text("Pas de programme disponible pour vos chaînes.").font(.system(size: 28)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(AmbientBackground())
        .task { await model.loadGuide() }
        .confirmationDialog(picked.map { "\($0.1.title)" } ?? "", isPresented: $showPick, titleVisibility: .visible) {
            if let pk = picked {
                let row = pk.0, p = pk.1
                let now = Date().timeIntervalSince1970
                if p.start <= now && now < p.end, let ch = model.liveIdx[row.key] {
                    Button("Regarder \(row.ch)") { Task { await model.playChannel(ch) } }
                }
                if p.start > now {
                    Button(model.hasReminder(row.key, p.start) ? "Supprimer le rappel" : "Me rappeler à \(hm(p.start))") {
                        Task { await model.toggleReminder(key: row.key, ch: row.ch, prog: p) }
                    }
                    if let ch = model.liveIdx[row.key] { Button("Regarder \(row.ch) maintenant") { Task { await model.playChannel(ch) } } }
                }
                Button("Annuler", role: .cancel) {}
            }
        } message: {
            if let pk = picked {
                let row = pk.0, p = pk.1
                Text("\(row.ch), \(hm(p.start)) – \(hm(p.end))" + ((p.desc ?? "").isEmpty ? "" : "\n\n" + (p.desc ?? "")))
            }
        }
    }

    private func grid(_ g: GuideData) -> some View {
        let t0 = g.t0, now = Date().timeIntervalSince1970
        let width = CGFloat((g.t1 - t0) / 60) * pxPerMin
        return VStack(alignment: .leading, spacing: 18) {
            Text("Guide des programmes").font(.system(size: 52, weight: .heavy)).padding(.leading, 80).padding(.top, 20)
            ScrollView(.vertical) {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 10) {
                        // heures
                        ZStack(alignment: .topLeading) {
                            Color.clear.frame(width: nameW + width, height: 34)
                            ForEach(hourMarks(t0, g.t1), id: \.self) { h in
                                Text(hm(h)).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.muted)
                                    .padding(.leading, nameW + CGFloat((h - t0) / 60) * pxPerMin)
                            }
                        }
                        ForEach(g.rows) { row in
                            HStack(spacing: 0) {
                                Text(row.ch).font(.system(size: 24, weight: .bold)).lineLimit(2)
                                    .frame(width: nameW - 20, height: rowH, alignment: .leading)
                                    .padding(.trailing, 20)
                                ZStack(alignment: .leading) {
                                    Color.clear.frame(width: width, height: rowH)
                                    ForEach(row.progs, id: \.self) { p in
                                        let s = max(p.start, t0), e = min(p.end, g.t1)
                                        if e > s {
                                            progButton(row, p, now: now)
                                                .frame(width: max(40, CGFloat((e - s) / 60) * pxPerMin - 8), height: rowH - 8)
                                                .padding(.leading, CGFloat((s - t0) / 60) * pxPerMin)
                                        }
                                    }
                                    // trait « maintenant »
                                    Rectangle().fill(Theme.wine).frame(width: 3, height: rowH)
                                        .padding(.leading, CGFloat((now - t0) / 60) * pxPerMin)
                                        .allowsHitTesting(false)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 80)
                    .padding(.vertical, 20)
                }
                .scrollClipDisabled()
            }
        }
    }

    private func progButton(_ row: GuideRow, _ p: GuideProg, now: Double) -> some View {
        let live = p.start <= now && now < p.end
        let past = p.end <= now
        return Button { picked = (row, p); showPick = true } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    if model.hasReminder(row.key, p.start) { Image(systemName: "bell.fill").foregroundStyle(Theme.accent2) }
                    Text(p.title).font(.system(size: 22, weight: .bold)).lineLimit(1)
                }
                Text("\(hm(p.start)) – \(hm(p.end))" + (p.tag.map { "  \($0)" } ?? ""))
                    .font(.system(size: 18)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(live ? Theme.accent.opacity(0.45) : Color.white.opacity(past ? 0.04 : 0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(past ? 0.55 : 1)
        }
        .buttonStyle(.card)
    }

    private func hourMarks(_ t0: Double, _ t1: Double) -> [Double] {
        var h = (t0 / 1800).rounded(.up) * 1800
        var out: [Double] = []
        while h < t1 { out.append(h); h += 1800 }
        return out
    }

    private func hm(_ t: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: t))
    }
}

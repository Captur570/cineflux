import SwiftUI

/// Une chaîne : logo, programme en cours avec sa progression. Appui long : Ma liste.
struct ChannelCard: View {
    @EnvironmentObject var model: AppModel
    let channel: Channel

    var body: some View {
        let now = model.current(channel)
        VStack(alignment: .leading, spacing: 12) {
            Button { Task { await model.playChannel(channel) } } label: {
                ZStack(alignment: .bottom) {
                    LinearGradient(colors: [Color.white.opacity(0.10), Color.white.opacity(0.03)], startPoint: .top, endPoint: .bottom)
                    if model.logo(channel) != nil {
                        RemoteImage(url: model.logo(channel), title: channel.t, showTitle: true, fit: true)
                    } else {
                        Text(channel.t).font(.system(size: 30, weight: .heavy)).multilineTextAlignment(.center).padding(20)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    if let n = now { ProgressBar(value: n.1).padding(.horizontal, 16).padding(.bottom, 12) }
                }
                .frame(width: 340, height: 200)
            }
            .buttonStyle(.card)
            .contextMenu {
                Button(model.isFav("live", channel.k) ? "Retirer de Ma liste" : "Ajouter à Ma liste") {
                    Task { await model.toggleFav("live", channel.k) }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    if let num = channel.num { Text("\(num)").foregroundStyle(Theme.muted) }
                    Text(channel.t).lineLimit(1)
                }
                .font(.system(size: 22, weight: .bold))
                Text(now?.0 ?? model.next(channel).map { "À suivre : \($0.title)" } ?? " ")
                    .font(.system(size: 20)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .frame(width: 340, alignment: .leading)
        }
        .task { if model.current(channel) == nil { await model.loadEpg(channel) } }
    }
}

/// Onglet Direct : catégories en haut, chaînes en grille.
struct LiveView: View {
    @EnvironmentObject var model: AppModel
    @State private var group: String?
    @State private var guideOpen = false

    private var groups: [LiveGroup] {
        let favs = model.favChannels
        return (favs.isEmpty ? [] : [LiveGroup(id: "_favs", title: "Mes chaînes", items: favs)]) + model.liveGroups
    }

    var body: some View {
        let gs = groups
        let cur = gs.first { $0.id == group } ?? gs.first
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .lastTextBaseline, spacing: 40) {
                    Text("Direct").font(.system(size: 60, weight: .heavy))
                    NavigationLink { GuideView() } label: {
                        Label("Guide des programmes", systemImage: "calendar").font(.system(size: 26, weight: .semibold))
                    }
                }
                .padding(.top, 30)
                if !model.liveEvents.isEmpty {
                    EventRow(title: "À la une en direct", icon: "dot.radiowaves.left.and.right", items: Array(model.liveEvents.prefix(16)), live: true)
                        .padding(.horizontal, -80)
                }
                if !model.tonight.isEmpty {
                    EventRow(title: "Ce soir chez vous", icon: "calendar", items: model.tonight).padding(.horizontal, -80)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 18) {
                        ForEach(gs) { g in
                            Button { group = g.id } label: {
                                Text(g.title)
                                    .font(.system(size: 24, weight: g.id == cur?.id ? .heavy : .semibold))
                                    .foregroundStyle(g.id == cur?.id ? .white : Theme.muted)
                                    .padding(.horizontal, 8)
                            }
                        }
                    }
                    .padding(.vertical, 16)
                }
                .scrollClipDisabled()
                if let c = cur {
                    Text("\(c.items.count) chaîne\(c.items.count > 1 ? "s" : "")").font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.muted)
                    LazyVGrid(columns: Array(repeating: GridItem(.fixed(340), spacing: 44, alignment: .top), count: 4), alignment: .leading, spacing: 44) {
                        ForEach(c.items) { ChannelCard(channel: $0) }
                    }
                } else {
                    Text("Aucune chaîne dans ce catalogue.").font(.system(size: 28)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 80)
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
        .task { await model.loadLiveNow(); await model.loadTonight() }
        .navigationDestination(isPresented: $guideOpen) { GuideView() }
        .task { if model.test?.route == "guide" { try? await Task.sleep(nanoseconds: 1_000_000_000); guideOpen = true } }
        .onAppear { model.zapList = cur?.items ?? [] }
        .onChange(of: group) { _, _ in model.zapList = (groups.first { $0.id == group } ?? groups.first)?.items ?? [] }
    }
}

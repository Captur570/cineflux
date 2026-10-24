import SwiftUI

#if DIAG_MINIMAL
/// Version de diagnostic minimale : mêmes réglages, icônes et fichiers que ShippoTV, mais aucun code lancé.
@main
struct ShippoTVApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 30) {
                Text("ShippoTV minimal").font(.system(size: 70, weight: .heavy))
                Text("Si vous lisez ceci, l'appli s'ouvre : le problème vient du code de ShippoTV, pas de son installation.")
                    .font(.system(size: 30)).multilineTextAlignment(.center).frame(maxWidth: 1300)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(red: 0.25, green: 0.04, blue: 0.1))
        }
    }
}
#elseif DIAG_STEPS
// point d'entrée : StepLauncher.swift
#else
/// Point d'entrée volontairement minimal : sur tvOS 27, initialiser l'état ou observer l'appli dès son
/// ouverture la refermait aussitôt. Tout démarre donc une fois la première vue affichée (comme la version
/// de diagnostic « pas à pas », qui fonctionne).
@main
struct ShippoTVApp: App {
    var body: some Scene {
        WindowGroup { AppRoot() }
    }
}

struct AppRoot: View {
    @State private var model: AppModel?
    @State private var previousCrash: [String]?
    @State private var checked = false

    var body: some View {
        ZStack {
            if let log = previousCrash {
                DiagView(log: log) { previousCrash = nil; Diag.clearPrevious(); boot() }
            } else if let m = model {
                RootView()
                    .environmentObject(m)
                    .task {
                        Diag.step("interface affichée")
                        await m.start()
                    }
            } else {
                Color(red: 11 / 255, green: 6 / 255, blue: 9 / 255).ignoresSafeArea()
            }
        }
        .preferredColorScheme(.dark)
        .task {
            guard !checked else { return }
            checked = true
            Diag.begin()
            if let p = Diag.previousCrash { previousCrash = p } else { boot() }
        }
    }

    private func boot() {
        Diag.step("cache des images")
        // affiches et images de fond gardées en cache (mémoire + disque)
        URLCache.shared = URLCache(memoryCapacity: 96 * 1024 * 1024, diskCapacity: 400 * 1024 * 1024)
        Diag.step("état de l'appli")
        model = AppModel()
    }
}

/// Écran affiché quand le lancement précédent s'est arrêté net : les dernières étapes atteintes.
struct DiagView: View {
    let log: [String]
    let onContinue: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Le lancement précédent s'est arrêté").font(.system(size: 52, weight: .heavy))
            Text("Prenez cet écran en photo : la dernière ligne indique où ShippoTV s'est arrêté.")
                .font(.system(size: 26)).foregroundStyle(Theme.muted)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if log.isEmpty { Text("(aucune étape enregistrée : arrêt avant le démarrage du code)") }
                    ForEach(Array(log.enumerated()), id: \.offset) { _, l in
                        Text(l).font(.system(size: 22, design: .monospaced)).lineLimit(3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 700)
            Button("Relancer ShippoTV", action: onContinue)
        }
        .padding(80)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(red: 0.06, green: 0.03, blue: 0.05).ignoresSafeArea())
    }
}
#endif

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack {
            switch model.phase {
            case .loading:
                LoadingView()
            case .setup:
                SetupView()
            case .profiles:
                ProfilePickerView()
            case .ready:
                MainTabs()
            case .failed(let msg):
                FailedView(message: msg)
            }
            if let b = model.busy {
                VStack(spacing: 24) {
                    ProgressView()
                    Text(b).font(.system(size: 30, weight: .bold))
                    Text("Le premier chargement du catalogue peut prendre une minute.").font(.system(size: 22)).foregroundStyle(Theme.muted)
                }
                .padding(60)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            }
            if let t = model.toast {
                VStack {
                    Spacer()
                    Text(t)
                        .font(.system(size: 26, weight: .bold))
                        .padding(.horizontal, 30).padding(.vertical, 18)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.bottom, 60)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task {
                    try? await Task.sleep(nanoseconds: 3_500_000_000)
                    withAnimation { model.toast = nil }
                }
            }
        }
        .animation(.easeInOut(duration: 0.35), value: model.phase)
    }
}

struct LoadingView: View {
    var body: some View {
        VStack(spacing: 30) {
            Image("Logo").resizable().frame(width: 140, height: 140).clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
                .shadow(color: Theme.accent.opacity(0.7), radius: 40)
            ProgressView()
            Text("Chargement du catalogue…").font(.system(size: 28, weight: .semibold)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AmbientBackground())
    }
}

struct FailedView: View {
    @EnvironmentObject var model: AppModel
    let message: String
    var body: some View {
        VStack(spacing: 30) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 90)).foregroundStyle(Theme.accent2)
            Text("Le catalogue n'a pas pu être chargé").font(.system(size: 44, weight: .bold))
            Text(message).font(.system(size: 26)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: 1200)
            Button("Réessayer") { model.phase = .loading; Task { await model.load() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AmbientBackground())
    }
}

/// Barre d'onglets native de l'Apple TV (en haut, en verre).
struct MainTabs: View {
    @EnvironmentObject var model: AppModel
    @State private var homePath = NavigationPath()
    @State private var seriesPath = NavigationPath()
    @State private var tab = "home"

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $homePath) {
                HomeView().withDetails()
            }
            .tabItem { Text("Accueil") }.tag("home")
            NavigationStack {
                MoviesView().withDetails()
            }
            .tabItem { Text("Films") }.tag("movies")
            NavigationStack(path: $seriesPath) {
                SeriesView().withDetails()
            }
            .tabItem { Text("Séries") }.tag("series")
            NavigationStack { LiveView() }
                .tabItem { Text("Direct") }.tag("live")
            NavigationStack {
                SearchView().withDetails()
            }
            .tabItem { Image(systemName: "magnifyingglass") }.tag("search")
            NavigationStack { SettingsView() }
                .tabItem { Text("Réglages") }.tag("settings")
        }
        .background(AmbientBackground())
        .task { await testRoute() }
    }

    /// Mode test (captures GitHub) : ouvrir directement un écran.
    private func testRoute() async {
        guard let route = model.test?.route else { return }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        let dune = model.catalog?.movies.first { $0.t.lowercased().contains("dune") } ?? model.catalog?.movies.first
        switch route {
        case "detail": if let d = dune { homePath.append(d) }
        case "player": if let d = dune { await model.play(d) }
        case "subs": if let s = model.test?.server { model.playURL("http://" + s.replacingOccurrences(of: "http://", with: "") + "/scope.mkv", title: "Test sous-titres") }
        case "series": tab = "series"
        case "series_detail":
            tab = "series"
            if let x = model.catalog?.series.first(where: { $0.t.lowercased().contains("breaking") }) ?? model.catalog?.series.first { seriesPath.append(x) }
        case "episode":
            if let x = model.catalog?.series.first(where: { $0.t.lowercased().contains("breaking") }) ?? model.catalog?.series.first,
               let r = await model.loadSeries(x) {
                let list = model.episodes(r.1, sid: r.0)
                if let e = list.dropFirst().first { await model.playEpisode(x, e, queue: Array(list.dropFirst(2))) }
            }
        case "live": tab = "live"
        case "live_play", "live_noimg", "live_4k":
            tab = "live"
            let key = route == "live_play" ? "france2" : route == "live_noimg" ? "france3" : "tf1"
            if let ch = model.liveIdx[key] ?? model.catalog?.live.first { await model.playChannel(ch) }
        case "search": tab = "search"
        default: break
        }
    }
}


extension View {
    /// Fiches film et série ouvrables depuis n'importe quel onglet.
    func withDetails() -> some View {
        navigationDestination(for: Movie.self) { MovieDetailView(movie: $0) }
            .navigationDestination(for: Series.self) { SeriesDetailView(series: $0) }
    }
}

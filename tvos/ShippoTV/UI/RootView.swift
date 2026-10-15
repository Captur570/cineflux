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
@main
struct ShippoTVApp: App {
    @StateObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var previousCrash: [String]?

    init() {
        Diag.begin()
        Diag.step("cache des images")
        // affiches et images de fond gardées en cache (mémoire + disque)
        URLCache.shared = URLCache(memoryCapacity: 96 * 1024 * 1024, diskCapacity: 400 * 1024 * 1024)
        Diag.step("état de l'appli")
        _model = StateObject(wrappedValue: AppModel())
        _previousCrash = State(initialValue: Diag.previousCrash)
        Diag.step("initialisation terminée")
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let log = previousCrash {
                    DiagView(log: log) { previousCrash = nil; Diag.clearPrevious() }
                } else {
                    RootView()
                        .environmentObject(model)
                        .task {
                            Diag.step("interface affichée")
                            await model.start()
                        }
                }
            }
            .preferredColorScheme(.dark)
            .tint(Theme.wine)
        }
        .onChange(of: scenePhase) { _, p in
            if p != .active { Engine.shared.flush() }
        }
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

    var body: some View {
        TabView {
            NavigationStack(path: $homePath) {
                HomeView().navigationDestination(for: Movie.self) { MovieDetailView(movie: $0) }
            }
            .tabItem { Text("Accueil") }
            NavigationStack {
                MoviesView().navigationDestination(for: Movie.self) { MovieDetailView(movie: $0) }
            }
            .tabItem { Text("Films") }
            NavigationStack { SettingsView() }
                .tabItem { Text("Réglages") }
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
        default: break
        }
    }
}

import SwiftUI

@main
struct ShippoTVApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // affiches et images de fond gardées en cache (mémoire + disque)
        URLCache.shared = URLCache(memoryCapacity: 96 * 1024 * 1024, diskCapacity: 400 * 1024 * 1024)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(Theme.wine)
                .task { await model.start() }
        }
        .onChange(of: scenePhase) { _, p in
            if p != .active { Engine.shared.flush() }
        }
    }
}

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

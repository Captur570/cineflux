#if DIAG_STEPS
import SwiftUI

/// Version de diagnostic « pas à pas » : chaque étape du démarrage de ShippoTV se lance avec un bouton.
/// Celle qui ferme l'appli est la coupable ; au lancement suivant, la dernière ligne notée s'affiche.
@main
struct StepLauncherApp: App {
    var body: some Scene {
        WindowGroup { StepLauncher() }
    }
}

private enum Trace {
    static func add(_ s: String) {
        var l = UserDefaults.standard.stringArray(forKey: "steps.log") ?? []
        l.append(s)
        if l.count > 40 { l.removeFirst(l.count - 40) }
        UserDefaults.standard.set(l, forKey: "steps.log")
        UserDefaults.standard.synchronize()
        NSLog("[étapes] %@", s)
    }
}

struct StepLauncher: View {
    @State private var previous: [String] = UserDefaults.standard.stringArray(forKey: "steps.log") ?? []
    @State private var lines: [String] = []
    @State private var model: AppModel?
    @State private var openApp = false

    var body: some View {
        if openApp, let m = model {
            RootView().environmentObject(m).preferredColorScheme(.dark)
                .task { Trace.add("6. interface : model.start()"); await m.start(); Trace.add("6. terminé") }
        } else {
            HStack(alignment: .top, spacing: 60) {
                VStack(alignment: .leading, spacing: 22) {
                    Text("ShippoTV — pas à pas").font(.system(size: 54, weight: .heavy))
                    Text("Lancez les étapes dans l'ordre. Si l'appli se ferme, rouvrez-la et prenez l'écran en photo.")
                        .font(.system(size: 24)).foregroundStyle(.secondary)
                    step("1. Journal de démarrage") { Diag.begin() }
                    step("2. Cache des images") {
                        URLCache.shared = URLCache(memoryCapacity: 96 * 1024 * 1024, diskCapacity: 400 * 1024 * 1024)
                    }
                    step("3. État de l'appli") { model = AppModel() }
                    step("4. Moteur JavaScript") { Engine.shared.start() }
                    Button("5. Lire les réglages du moteur") {
                        Trace.add("5. lire les réglages")
                        lines.append("… 5. lecture des réglages")
                        Task {
                            do {
                                let d = try await Engine.shared.data("/api/config")
                                lines.append("✓ 5. réglages : \(String(decoding: d.prefix(120), as: UTF8.self))")
                                Trace.add("5. OK")
                            } catch {
                                lines.append("✗ 5. erreur : \(error.localizedDescription)")
                                Trace.add("5. erreur : \(error.localizedDescription)")
                            }
                        }
                    }
                    Button("6. Ouvrir ShippoTV") {
                        if model == nil { model = AppModel() }
                        Trace.add("6. ouverture de l'interface")
                        openApp = true
                    }
                }
                .frame(width: 900, alignment: .leading)
                VStack(alignment: .leading, spacing: 8) {
                    if !previous.isEmpty {
                        Text("Lancement précédent :").font(.system(size: 26, weight: .bold))
                        ForEach(Array(previous.suffix(14).enumerated()), id: \.offset) { _, l in
                            Text(l).font(.system(size: 20, design: .monospaced)).lineLimit(2)
                        }
                        Divider().padding(.vertical, 10)
                    }
                    Text("Maintenant :").font(.system(size: 26, weight: .bold))
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        Text(l).font(.system(size: 20, design: .monospaced)).lineLimit(3)
                    }
                    let diag = UserDefaults.standard.stringArray(forKey: "diag.log") ?? []
                    if !diag.isEmpty {
                        Divider().padding(.vertical, 10)
                        Text("Détail du moteur :").font(.system(size: 22, weight: .bold))
                        ForEach(Array(diag.suffix(8).enumerated()), id: \.offset) { _, l in
                            Text(l).font(.system(size: 18, design: .monospaced)).lineLimit(2)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(70)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color(red: 0.08, green: 0.03, blue: 0.06).ignoresSafeArea())
            .onAppear {
                UserDefaults.standard.set([String](), forKey: "steps.log")
                Trace.add("0. lanceur ouvert")
            }
        }
    }

    private func step(_ name: String, _ run: @escaping () -> Void) -> some View {
        Button(name) {
            Trace.add(name + " : début")
            run()
            Trace.add(name + " : OK")
            lines.append("✓ " + name)
        }
    }
}
#endif

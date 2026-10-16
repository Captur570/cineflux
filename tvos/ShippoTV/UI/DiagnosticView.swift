import SwiftUI
import UIKit

/// Réglages › Diagnostic : teste en direct, sur l'Apple TV, chaque maillon (clé TMDB, fiches, images,
/// synchronisation) et affiche le résultat en clair, pour corriger sans deviner.
struct DiagnosticView: View {
    @EnvironmentObject var model: AppModel
    @State private var lines: [(String, String, Bool?)] = []
    @State private var running = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Diagnostic").font(.system(size: 56, weight: .heavy))
                Text("Prenez cet écran en photo une fois les tests terminés.").font(.system(size: 24)).foregroundStyle(Theme.muted)
                Button(running ? "Tests en cours…" : "Relancer les tests") { Task { await run() } }.disabled(running)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        HStack(alignment: .top, spacing: 16) {
                            Image(systemName: l.2 == nil ? "info.circle" : l.2! ? "checkmark.circle.fill" : "xmark.octagon.fill")
                                .foregroundStyle(l.2 == nil ? Theme.muted : l.2! ? Color.green : Theme.accent2)
                                .font(.system(size: 26))
                            Text(l.0).font(.system(size: 24, weight: .bold)).frame(width: 330, alignment: .leading)
                            Text(l.1).font(.system(size: 22, design: .monospaced)).lineLimit(4)
                        }
                    }
                }
                .padding(30)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            }
            .padding(80)
        }
        .task { await run() }
    }

    private func add(_ k: String, _ v: String, _ ok: Bool? = nil) { lines.append((k, v, ok)) }

    private func run() async {
        running = true
        defer { running = false }
        lines = []
        // 1. réglages vus par le moteur
        guard let d = try? await Engine.shared.data("/api/config"),
              let c = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
            add("Moteur", "réglages illisibles", false); return
        }
        add("Version", "\(c["version"] ?? "?") · plateforme \(c["platform"] ?? "?")")
        add("Abonnement", "\(c["configured"] as? Bool == true ? "configuré" : "NON configuré") · \(c["server"] ?? "")", c["configured"] as? Bool == true)
        let has = c["has_tmdb"] as? Bool == true
        add("Clé TMDB", has ? "présente (\(c["own_tmdb"] as? Bool == true ? "reçue d'un autre appareil" : "intégrée"))" : "ABSENTE", has)
        add("Fiches en mémoire", "\(model.meta.count) fiches · \(model.catalog?.movies.count ?? 0) films")

        // 2. une fiche TMDB demandée maintenant
        var poster: URL? = nil
        if let m = model.catalog?.movies.first {
            let body: [String: Any] = ["items": [["kind": "movie", "key": m.k, "title": m.t, "year": m.y as Any? ?? NSNull()]]]
            do {
                let r = try await Engine.shared.data("/api/enrich", body)
                let txt = String(decoding: r.prefix(160), as: UTF8.self)
                let res = try? JSONDecoder().decode([String: Meta?].self, from: r)
                let meta = res?["m:" + m.k] ?? nil
                add("Fiche TMDB (\(m.t.prefix(18)))", meta == nil ? "aucune fiche : \(txt)" : "OK · affiche \(meta?.p ?? "—")", meta != nil)
                poster = TMDBImage.url(meta?.p, size: "w342")
            } catch {
                add("Fiche TMDB", "erreur : \(error.localizedDescription)", false)
            }
        }

        // 3. téléchargement d'une image
        if let u = poster ?? URL(string: "https://image.tmdb.org/t/p/w92/wwemzKWzjKYJFfCeiB57q3r4Bcm.png") {
            do {
                let (data, resp) = try await URLSession.shared.data(from: u)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let img = UIImage(data: data) != nil
                add("Image TMDB", "HTTP \(code) · \(data.count) octets · image \(img ? "lisible" : "illisible") · \(u.absoluteString.suffix(40))", code == 200 && img)
            } catch {
                add("Image TMDB", "erreur réseau : \(error.localizedDescription)", false)
            }
        }

        // 4. synchronisation
        if let d = try? await Engine.shared.data("/api/sync"),
           let s = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            let inGroup = s["in_group"] as? Bool == true
            let last = (s["last_ok"] as? NSNumber)?.doubleValue ?? 0
            let ago = last > 0 ? "il y a \(Int(Date().timeIntervalSince1970 - last)) s" : "jamais"
            add("Synchronisation", "\(s["configured"] as? Bool == true ? "serveur OK" : "serveur NON configuré") · groupe : \(inGroup ? "« \(s["group_name"] ?? "")»" : "aucun") · dernier échange : \(ago)", inGroup)
            if let e = s["error"] as? String, !e.isEmpty { add("Erreur de synchro", e, false) }
            let devs = (s["devices"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
            if !devs.isEmpty { add("Appareils du groupe", devs.joined(separator: ", ")) }
        }
        add("Dernière association", model.lastJoin ?? "aucune depuis le lancement")
        add("Dernière erreur d'affiches", model.lastMetaError ?? "aucune")
        add("Messages du moteur", model.lastEvents.isEmpty ? "aucun depuis le lancement" : model.lastEvents.suffix(5).joined(separator: " | "))
    }
}

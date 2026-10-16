import SwiftUI

/// Réglages : abonnement (téléphone), synchronisation, profil, catalogue, à propos.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var sync: SyncStatus?
    @State private var code = ""
    @State private var syncError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                Text("Réglages").font(.system(size: 60, weight: .heavy))

                section("Abonnement", icon: "person.crop.circle") {
                    Text("Serveur : \(model.cfg?.server ?? "—")   ·   Identifiant : \(model.cfg?.username ?? "—")")
                        .font(.system(size: 24)).foregroundStyle(Theme.muted)
                    HStack(spacing: 24) {
                        NavigationLink("Changer avec mon téléphone") {
                            PhoneSetupPanel { Task { await model.load() } }
                                .padding(80)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .background(AmbientBackground())
                        }
                        NavigationLink("Saisie manuelle") { ManualSetupView() }
                    }
                }

                section("Synchronisation entre appareils", icon: "arrow.triangle.2.circlepath") {
                    if let s = sync {
                        if s.in_group == true {
                            Text("Groupe « \(s.group_name ?? "") » : reprises, Ma liste et profils sont partagés avec vos autres appareils.")
                                .font(.system(size: 24)).foregroundStyle(Theme.muted)
                        } else {
                            Text("Pas encore associée. Sur le PC : Réglages › Synchronisation › Associer un appareil, puis saisissez le code ici.")
                                .font(.system(size: 24)).foregroundStyle(Theme.muted)
                        }
                        if let e = s.error, !e.isEmpty { Text(e).font(.system(size: 22)).foregroundStyle(Theme.accent2) }
                    }
                    HStack(spacing: 20) {
                        TextField("Code de jumelage", text: $code).frame(width: 420).autocorrectionDisabled()
                        Button("Associer") { Task { await join() } }
                        if sync?.in_group == true { Button("Synchroniser maintenant") { Engine.shared.send("/api/sync", ["action": "now"]) } }
                    }
                    if let e = syncError { Text(e).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.accent2) }
                }

                if (model.cfg?.profiles.count ?? 0) > 1 {
                    section("Profil", icon: "person.2") {
                        HStack(spacing: 20) {
                            ForEach(model.cfg?.profiles ?? []) { p in
                                Button { Task { await model.chooseProfile(p) } } label: {
                                    Label(p.name, systemImage: p.id == model.profileId ? "checkmark.circle.fill" : "circle")
                                }
                            }
                        }
                    }
                }

                section("Diagnostic", icon: "stethoscope") {
                    Text("Teste la clé TMDB, les affiches et la synchronisation sur cette Apple TV.").font(.system(size: 24)).foregroundStyle(Theme.muted)
                    NavigationLink("Lancer le diagnostic") { DiagnosticView().background(AmbientBackground()) }
                }

                section("Catalogue", icon: "arrow.clockwise") {
                    Text("Le catalogue se met à jour tout seul toutes les 24 h.").font(.system(size: 24)).foregroundStyle(Theme.muted)
                    Button("Actualiser maintenant") {
                        Engine.shared.send("/api/refresh", [:])
                        model.toast = "Mise à jour du catalogue lancée en arrière-plan"
                    }
                }

                section("À propos", icon: "info.circle") {
                    Text("ShippoTV \(model.cfg?.version ?? "") pour Apple TV").font(.system(size: 26, weight: .bold))
                    Text("Jaquettes, résumés et informations : The Movie Database (TMDB). This product uses the TMDB API but is not endorsed or certified by TMDB.")
                        .font(.system(size: 20)).foregroundStyle(Theme.muted)
                    Text("ShippoTV ne fournit aucun contenu : il lit uniquement l'abonnement que vous renseignez.")
                        .font(.system(size: 20)).foregroundStyle(Theme.muted)
                }
            }
            .padding(80)
        }
        .task { sync = try? await Engine.shared.call("/api/sync") }
    }

    private func section<C: View>(_ title: String, icon: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(title, systemImage: icon).font(.system(size: 32, weight: .bold))
            content()
        }
        .padding(36)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
    }

    private func join() async {
        syncError = nil
        do {
            model.busy = "Association en cours…"
            defer { model.busy = nil }
            let raw = try await Engine.shared.data("/api/sync", ["action": "join", "code": code])
            model.lastJoin = String(decoding: raw.prefix(200), as: UTF8.self)
            let r = try JSONDecoder().decode(SyncStatus.self, from: raw)
            if let e = r.error { syncError = e; return }
            model.busy = "Associée : chargement du catalogue et des réglages…"
            sync = r
            code = ""
            let hadTMDB = model.cfg?.has_tmdb == true
            await model.load()
            await model.reloadConfig()
            model.prefetchPosters()
            if model.cfg?.has_tmdb == true {
                model.toast = hadTMDB ? "Associée : vos reprises et Ma liste arrivent" : "Associée, clé TMDB reçue : les affiches arrivent"
            } else {
                model.toast = "Associée. Pour les affiches, refaites un code sur le PC en cochant « identifiants IPTV et clé TMDB »"
            }
        } catch { syncError = error.localizedDescription }
    }
}

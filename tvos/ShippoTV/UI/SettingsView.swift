import SwiftUI

/// Réglages : abonnement (téléphone), synchronisation, profil, catalogue, à propos.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var sync: SyncStatus?
    @State private var code = ""
    @State private var liveVLC = AppModel.liveAlwaysVLC
    @State private var useInfuse = Infuse.always
    @State private var others: [OtherDevice] = []
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

                section("En lecture ailleurs", icon: "rectangle.on.rectangle") {
                    if others.isEmpty {
                        Text("Aucune lecture en cours sur vos autres appareils.").font(.system(size: 24)).foregroundStyle(Theme.muted)
                    } else {
                        ForEach(others) { o in
                            HStack(spacing: 24) {
                                Text("\(o.name ?? "Appareil") : \(o.title ?? "lecture en cours")").font(.system(size: 26, weight: .semibold))
                                Button("Arrêter") { Task { await model.stopRemote(o); others = (await model.others())?.others ?? [] } }
                            }
                        }
                    }
                }
                .task { others = (await model.others())?.others ?? [] }

                section("Direct", icon: "dot.radiowaves.left.and.right") {
                    Text(liveVLC ? "Les chaînes sont lues avec VLC." : "Les chaînes sont lues avec le lecteur de l'Apple TV quand c'est possible, sinon avec VLC (4K, ou image absente).")
                        .font(.system(size: 24)).foregroundStyle(Theme.muted)
                    Button(liveVLC ? "Lecteur du direct : VLC" : "Lecteur du direct : automatique") {
                        liveVLC.toggle()
                        AppModel.liveAlwaysVLC = liveVLC
                    }
                }

                section("Films et séries", icon: "play.rectangle") {
                    Text(useInfuse ? "Les films et les séries s'ouvrent dans Infuse. La reprise est enregistrée quand vous revenez dans ShippoTV."
                         : (Infuse.installed ? "Lecteur intégré (VLC). Un bouton « Infuse » est aussi proposé sur chaque fiche." : "Lecteur intégré (VLC). Installez Infuse depuis l'App Store pour pouvoir l'utiliser."))
                        .font(.system(size: 24)).foregroundStyle(Theme.muted)
                    Button(useInfuse ? "Lire avec : Infuse" : "Lire avec : ShippoTV") {
                        useInfuse.toggle()
                        Infuse.always = useInfuse
                        if useInfuse && !Infuse.installed { model.toast = "Infuse n'est pas installé sur cette Apple TV" }
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
            if let e = r.error, !e.isEmpty { syncError = e; return }
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

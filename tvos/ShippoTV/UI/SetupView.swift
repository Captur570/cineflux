import SwiftUI
import UIKit
import CoreImage.CIFilterBuiltins

/// QR code dessiné par l'Apple TV (CoreImage), net à toute taille.
struct QRCodeView: View {
    let text: String
    var body: some View {
        if let img = Self.make(text) {
            Image(uiImage: img).interpolation(.none).resizable().scaledToFit()
        } else {
            Color.white
        }
    }
    static func make(_ s: String) -> UIImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(s.utf8)
        f.correctionLevel = "L"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// Bloc « Configurer avec mon téléphone » : QR code + suivi en direct (même circuit que la télé Samsung).
struct PhoneSetupPanel: View {
    @EnvironmentObject var model: AppModel
    var onDone: () -> Void
    @State private var url: String?
    @State private var status = "En attente du téléphone…"
    @State private var bad = false
    @State private var ok = false
    @State private var unavailable: String?

    var body: some View {
        HStack(alignment: .center, spacing: 60) {
            ZStack {
                RoundedRectangle(cornerRadius: 30, style: .continuous).fill(.white)
                if let u = url { QRCodeView(text: u).padding(26) } else { ProgressView().tint(.black) }
            }
            .frame(width: 440, height: 440)
            .shadow(color: Theme.accent.opacity(0.6), radius: 30)
            VStack(alignment: .leading, spacing: 22) {
                Label("Configurer avec mon téléphone", systemImage: "iphone")
                    .font(.system(size: 40, weight: .bold))
                step(1, "Ouvrez l'**appareil photo** de votre téléphone et visez ce QR code.")
                step(2, "Touchez le lien : une page ShippoTV s'ouvre.")
                step(3, "Collez ou tapez votre **serveur**, votre **identifiant** et votre **mot de passe**, puis « Envoyer ».")
                HStack(spacing: 14) {
                    if ok { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                    else if !bad && unavailable == nil { ProgressView() }
                    Text(unavailable ?? status).font(.system(size: 26, weight: .semibold))
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background((bad || unavailable != nil ? Theme.accent.opacity(0.25) : ok ? Color.green.opacity(0.18) : Color.white.opacity(0.08)),
                            in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                Text("Les identifiants voyagent chiffrés et ne sont lisibles que par cette Apple TV. Code valable 10 minutes.")
                    .font(.system(size: 20)).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: 900, alignment: .leading)
        }
        .task { await run() }
        .onDisappear { Engine.shared.send("/api/phone_setup", ["action": "cancel"]) }
    }

    private func step(_ n: Int, _ s: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Text("\(n)").font(.system(size: 24, weight: .heavy)).frame(width: 42, height: 42)
                .background(Theme.accent, in: Circle())
            Text(s).font(.system(size: 26))
        }
    }

    private func run() async {
        guard let st: PhoneStart = try? await Engine.shared.call("/api/phone_setup", ["action": "start"]), let u = st.url else {
            unavailable = "Configuration par téléphone indisponible (synchronisation non configurée dans cette version)."
            return
        }
        url = u
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard let r: PhoneState = try? await Engine.shared.call("/api/phone_setup") else { continue }
            switch r.state {
            case "done":
                ok = true; bad = false
                status = "Identifiants reçus, connexion réussie !"
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                onDone()
                return
            case "expired", "none":
                bad = true
                status = "Le code a expiré : revenez en arrière et rouvrez cet écran."
                return
            default:
                if r.tried == true {
                    bad = true
                    status = "Connexion refusée\(r.error.map { " : " + $0 } ?? ""). Corrigez les identifiants sur le téléphone et renvoyez."
                }
            }
        }
    }
}

/// Premier lancement : téléphone (QR code), code de jumelage du PC, ou saisie à la télécommande.
struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var code = ""
    @State private var joining = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 40) {
                    HStack(spacing: 18) {
                        Image("Logo").resizable().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Text("Bienvenue sur ShippoTV").font(.system(size: 60, weight: .heavy))
                    }
                    PhoneSetupPanel { Task { await model.load() } }
                        .padding(40)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 36, style: .continuous))
                    HStack(alignment: .top, spacing: 40) {
                        VStack(alignment: .leading, spacing: 18) {
                            Label("Vous avez déjà ShippoTV sur un PC ?", systemImage: "arrow.triangle.2.circlepath").font(.system(size: 30, weight: .bold))
                            Text("Sur le PC : Réglages › Synchronisation › Associer un appareil, puis saisissez le code affiché.")
                                .font(.system(size: 24)).foregroundStyle(Theme.muted)
                            HStack(spacing: 20) {
                                TextField("Code (ex. ABC 123)", text: $code)
                                    .textInputAutocapitalization(.characters)
                                    .autocorrectionDisabled()
                                    .frame(width: 420)
                                Button(joining ? "…" : "Valider") { Task { await join() } }.disabled(joining)
                            }
                            if let e = error { Text(e).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.accent2) }
                        }
                        .padding(36)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
                        VStack(alignment: .leading, spacing: 18) {
                            Label("À la télécommande", systemImage: "keyboard").font(.system(size: 30, weight: .bold))
                            Text("Saisir l'adresse du serveur, l'identifiant et le mot de passe directement sur l'Apple TV.")
                                .font(.system(size: 24)).foregroundStyle(Theme.muted)
                            NavigationLink("Saisie manuelle") { ManualSetupView() }
                        }
                        .padding(36)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
                    }
                }
                .padding(80)
            }
            .background(AmbientBackground())
        }
    }

    private func join() async {
        joining = true
        defer { joining = false }
        error = nil
        do {
            let r: SyncStatus = try await Engine.shared.call("/api/sync", ["action": "join", "code": code])
            if let e = r.error { error = e; return }
            await model.load()
            if model.phase == .setup { error = "Synchronisé : il reste à saisir vos identifiants IPTV (QR code ou saisie manuelle)." }
        } catch { self.error = error.localizedDescription }
    }
}

/// Saisie à la télécommande (secours).
struct ManualSetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var server = ""
    @State private var user = ""
    @State private var pass = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 30) {
            Text("Saisie manuelle").font(.system(size: 56, weight: .heavy))
            Text("Vous pouvez aussi coller votre lien M3U complet dans « Adresse du serveur » : identifiant et mot de passe seront remplis tout seuls.")
                .font(.system(size: 24)).foregroundStyle(Theme.muted).frame(maxWidth: 1300, alignment: .leading)
            TextField("Adresse du serveur (http://exemple.com:8080)", text: $server).autocorrectionDisabled().textInputAutocapitalization(.never)
            TextField("Identifiant", text: $user).autocorrectionDisabled().textInputAutocapitalization(.never)
            SecureField("Mot de passe", text: $pass)
            if let e = error { Text(e).font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.accent2) }
            Button(busy ? "Connexion…" : "Se connecter") { Task { await save() } }.disabled(busy)
        }
        .frame(maxWidth: 1300)
        .padding(80)
        .background(AmbientBackground())
    }

    private func save() async {
        busy = true
        defer { busy = false }
        error = nil
        var body: [String: Any] = ["server": server, "username": user]
        if !pass.isEmpty { body["password"] = pass }
        do {
            _ = try await Engine.shared.data("/api/config", body)
            await model.load()
        } catch { self.error = error.localizedDescription }
    }
}

/// Choix du profil (plusieurs profils synchronisés depuis le PC).
struct ProfilePickerView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 60) {
            Text("Qui regarde ?").font(.system(size: 64, weight: .heavy))
            HStack(spacing: 60) {
                ForEach(model.cfg?.profiles ?? []) { p in
                    Button { Task { await model.chooseProfile(p) } } label: {
                        VStack(spacing: 20) {
                            Text(String(p.name.prefix(1)).uppercased())
                                .font(.system(size: 90, weight: .heavy))
                                .frame(width: 220, height: 220)
                                .background(Color(hex: p.color ?? "#a51d43"), in: Circle())
                            Text(p.name).font(.system(size: 30, weight: .semibold))
                        }
                        .padding(20)
                    }
                    .buttonStyle(.card)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AmbientBackground())
    }
}

extension Color {
    init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
    }
}

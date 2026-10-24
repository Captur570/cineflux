import Foundation
import UIKit

/// Étape 3 et V2 : lectures sur les autres appareils, arrêt à distance, zapping, guide des programmes, rappels.
extension AppModel {

    // MARK: - Fenêtres de choix (UIKit : s'affichent aussi par-dessus un lecteur ouvert)

    struct Choice { let title: String; let style: UIAlertAction.Style; let value: Int }

    func ask(_ title: String, _ message: String?, _ choices: [Choice]) async -> Int? {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return nil }
        var top = root
        while let p = top.presentedViewController { top = p }
        return await withCheckedContinuation { cont in
            let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
            for c in choices { a.addAction(UIAlertAction(title: c.title, style: c.style) { _ in cont.resume(returning: c.value) }) }
            top.present(a, animated: true)
        }
    }

    // MARK: - Lectures ailleurs (abonnement limité en écrans)

    func others() async -> Others? { try? await Engine.shared.call("/api/others") }

    /// Avant une lecture : si l'abonnement est déjà utilisé ailleurs, proposer d'arrêter l'autre appareil.
    func freeToPlay() async -> Bool {
        guard let r = await others(), !r.others.isEmpty else { return true }
        let max = Int(catalog?.account?.max?.value ?? "") ?? r.max ?? 1
        guard r.others.count >= max, let o = r.others.first else { return true }
        let name = o.name ?? "un autre appareil"
        let msg = (o.title.map { "« \($0) » est en cours de lecture sur cet appareil. " } ?? "")
            + "Votre abonnement ne permet \(max > 1 ? "que \(max) lectures" : "qu'une lecture") à la fois."
        let c = await ask("Déjà en lecture sur « \(name) »", msg, [
            Choice(title: "Arrêter sur « \(name) » et lire ici", style: .default, value: 1),
            Choice(title: "Lire quand même", style: .default, value: 2),
            Choice(title: "Annuler", style: .cancel, value: 0),
        ])
        switch c {
        case 1:
            await stopRemote(o)
            return true
        case 2: return true
        default: return false
        }
    }

    /// Arrêt à distance : demande transmise par la synchronisation, puis on attend que l'appareil ait arrêté.
    func stopRemote(_ o: OtherDevice) async {
        toast = "Arrêt demandé à « \(o.name ?? "l'autre appareil") »…"
        _ = try? await Engine.shared.data("/api/remote_stop", ["device": o.id])
        let t0 = Date()
        while Date().timeIntervalSince(t0) < 45 {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if let x = await others(), !x.others.contains(where: { $0.id == o.id }) { break }
        }
        try? await Task.sleep(nanoseconds: 3_000_000_000)   // le temps que le fournisseur libère la connexion
        toast = nil
    }

    // MARK: - Zapping (haut / bas dans le lecteur du direct)

    func zapTarget(from ch: Channel, delta: Int) -> Channel? {
        var list = zapList.contains(where: { $0.k == ch.k }) ? zapList : []
        if list.isEmpty { list = liveGroups.first { g in g.items.contains { $0.k == ch.k } }?.items ?? [] }
        guard list.count > 1, let i = list.firstIndex(where: { $0.k == ch.k }) else { return nil }
        return list[(i + delta + list.count) % list.count]
    }

    func zap(from ch: Channel, delta: Int) async {
        guard let next = zapTarget(from: ch, delta: delta) else { return }
        PlayerPresenter.closeIfOpen()
        LivePlayer.closeIfOpen()
        try? await Task.sleep(nanoseconds: 700_000_000)   // fin de la fermeture avant d'ouvrir la chaîne suivante
        await playChannel(next, checkOthers: false)
    }

    // MARK: - Guide des programmes

    func loadGuide() async {
        if let g: GuideData = try? await Engine.shared.call("/api/guide") { guide = g }
    }

    // MARK: - Rappels (synchronisés ; message dans ShippoTV quand le programme commence)

    func hasReminder(_ key: String, _ start: Double) -> Bool {
        (cfg?.reminders ?? []).contains { $0.key == key && $0.start == start }
    }

    func toggleReminder(key: String, ch: String, prog: GuideProg) async {
        let on = !hasReminder(key, prog.start)
        _ = try? await Engine.shared.data("/api/reminder", ["on": on, "key": key, "ch": ch, "title": prog.title, "start": prog.start, "end": prog.end])
        await reloadConfig()
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        toast = on ? "Rappel : \(prog.title), \(f.string(from: Date(timeIntervalSince1970: prog.start))) sur \(ch)" : "Rappel supprimé"
    }

    func startReminders() {
        guard !remindersStarted else { return }
        remindersStarted = true
        Task {
            while true {
                await checkReminders()
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
        }
    }

    private func checkReminders() async {
        let now = Date().timeIntervalSince1970
        for r in cfg?.reminders ?? [] {
            let id = "\(r.key)@\(Int(r.start))"
            guard !reminded.contains(id), now >= r.start - 60, now < (r.end ?? r.start + 3600) else { continue }
            reminded.insert(id)
            let ch = liveIdx[r.key]
            let c = await ask("Ça commence sur \(r.ch ?? ch?.t ?? "la chaîne")", r.title ?? "",
                              ch == nil ? [Choice(title: "OK", style: .cancel, value: 0)]
                                        : [Choice(title: "Regarder", style: .default, value: 1), Choice(title: "Plus tard", style: .cancel, value: 0)])
            if c == 1, let ch {
                PlayerPresenter.closeIfOpen()
                LivePlayer.closeIfOpen()
                try? await Task.sleep(nanoseconds: 700_000_000)
                await playChannel(ch)
            }
        }
    }
}

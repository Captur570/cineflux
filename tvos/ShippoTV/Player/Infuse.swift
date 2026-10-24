import UIKit

/// Lecture dans Infuse (si installé) : ShippoTV lui passe l'adresse du film ou de l'épisode et la position de reprise.
/// Quand on quitte Infuse, il rouvre ShippoTV (shippotv://infuse…) avec la position atteinte, enregistrée comme
/// avec le lecteur intégré (reprise synchronisée avec les autres appareils).
enum Infuse {
    /// Réglage « Lire les films et séries avec Infuse ».
    static var always: Bool {
        get { UserDefaults.standard.bool(forKey: "vod.infuse") }
        set { UserDefaults.standard.set(newValue, forKey: "vod.infuse") }
    }

    @MainActor static var installed: Bool {
        URL(string: "infuse://").map { UIApplication.shared.canOpenURL($0) } ?? false
    }

    /// Ce qu'il faut pour enregistrer la progression au retour d'Infuse.
    struct Pending { let body: [String: Any]; let dur: Double }
    @MainActor private(set) static var pending: [String: Pending] = [:]

    /// Ouvre Infuse ; renvoie false s'il n'est pas installé ou refuse l'ouverture.
    @MainActor static func play(url: String, start: Double, filename: String, progress: [String: Any], dur: Double) async -> Bool {
        guard installed else { return false }
        let token = UUID().uuidString.prefix(8).lowercased()
        pending[String(token)] = Pending(body: progress, dur: dur)
        var back = URLComponents()
        back.scheme = "shippotv"
        back.host = "infuse"
        back.queryItems = [URLQueryItem(name: "t", value: String(token))]
        var c = URLComponents()
        c.scheme = "infuse"
        c.host = "x-callback-url"
        c.path = "/play"
        var items = [URLQueryItem(name: "url", value: url)]
        if start > 30 { items.append(URLQueryItem(name: "position", value: String(Int(start)))) }
        items.append(URLQueryItem(name: "filename", value: filename))
        items.append(URLQueryItem(name: "x-success", value: back.url?.absoluteString))
        items.append(URLQueryItem(name: "x-error", value: back.url?.absoluteString.appending("&error=1")))
        c.queryItems = items
        // « + » et « & » dans les valeurs doivent être échappés (l'adresse du flux contient l'identifiant)
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let u = c.url else { return false }
        return await UIApplication.shared.open(u)
    }

    /// Retour d'Infuse : position atteinte → progression (comme le lecteur intégré).
    @MainActor static func handle(_ url: URL) -> (body: [String: Any], error: Bool)? {
        guard url.scheme == "shippotv", url.host == "infuse",
              let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let t = q.first(where: { $0.name == "t" })?.value, let p = pending.removeValue(forKey: t) else { return nil }
        if q.contains(where: { $0.name == "error" || $0.name == "errorCode" }) { return (p.body, true) }
        let pos = q.first(where: { $0.name == "position" }).flatMap { $0.value.flatMap(Double.init) } ?? 0
        guard pos > 5 else { return nil }
        var body = p.body
        body["pos"] = pos
        if p.dur > 0 {
            body["dur"] = p.dur
            if pos / p.dur > 0.94 { body["clear"] = true }
        } else {
            body["dur"] = max(pos * 1.25, pos + 600)   // durée inconnue : on garde au moins la position de reprise
        }
        return (body, false)
    }
}

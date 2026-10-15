import SwiftUI

/// Couleurs ShippoTV (thème « Fusion » bordeaux, comme sur PC, télé et iPad).
enum Theme {
    static let bg = Color(red: 11 / 255, green: 6 / 255, blue: 9 / 255)
    static let accent = Color(red: 165 / 255, green: 29 / 255, blue: 67 / 255)
    static let accent2 = Color(red: 243 / 255, green: 167 / 255, blue: 187 / 255)
    static let wine = Color(red: 214 / 255, green: 55 / 255, blue: 95 / 255)
    static let muted = Color.white.opacity(0.62)

    /// Teinte stable dérivée d'un titre (affiches sans image).
    static func hue(_ s: String) -> Color {
        var h: UInt32 = 2166136261
        for b in s.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        return Color(hue: Double(h % 360) / 360, saturation: 0.55, brightness: 0.42)
    }
}

/// Fond d'ambiance : halos bordeaux sur fond sombre.
struct AmbientBackground: View {
    var tint: Color = Theme.accent
    var body: some View {
        ZStack {
            Theme.bg
            RadialGradient(colors: [tint.opacity(0.55), .clear], center: UnitPoint(x: 0.1, y: -0.1), startRadius: 0, endRadius: 1100)
            RadialGradient(colors: [Color(red: 0.43, green: 0.08, blue: 0.19).opacity(0.45), .clear], center: UnitPoint(x: 1.05, y: 1.1), startRadius: 0, endRadius: 1000)
        }
        .ignoresSafeArea()
    }
}

/// Image distante avec repli dégradé + titre (pas de clé TMDB, image absente).
struct RemoteImage: View {
    let url: URL?
    let title: String
    var showTitle = true

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.hue(title), Theme.hue(title).opacity(0.35), Theme.bg], startPoint: .topLeading, endPoint: .bottomTrailing)
            if showTitle {
                Text(title)
                    .font(.system(size: 26, weight: .bold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.92))
                    .padding(18)
            }
            if let url = url {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.35))) { phase in
                    if case .success(let img) = phase { img.resizable().scaledToFill().transition(.opacity) }
                }
            }
        }
        .clipped()
    }
}

/// Petite étiquette (qualité, note).
struct Badge: View {
    let text: String
    var accent = false
    var body: some View {
        Text(text)
            .font(.system(size: 20, weight: .heavy))
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(accent ? Theme.accent : Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .foregroundStyle(.white)
    }
}

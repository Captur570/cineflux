import SwiftUI

@main
struct HelloTVApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var clicks = 0

    var body: some View {
        VStack(spacing: 48) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 140))
                .foregroundStyle(.green)
            Text("ATVLoad fonctionne !")
                .font(.largeTitle).bold()
            Text("Cette app a été signée avec un Apple ID gratuit et installée depuis Windows.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Tester la télécommande : \(clicks)") { clicks += 1 }
        }
        .padding(80)
    }
}

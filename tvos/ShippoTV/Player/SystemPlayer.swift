#if !canImport(VLCKit) && !canImport(TVVLCKit)
import UIKit
import AVKit

/// Lecteur de secours sans VLC (lecteur Apple) : utilisé seulement par la version de diagnostic
/// fabriquée sans VLC, pour vérifier que l'appli s'ouvre sur l'Apple TV.
final class PlayerViewController: AVPlayerViewController {
    struct Source { let url: String; let label: String; let id: FlexID }
    struct Item { let title: String; let subtitle: String; let live: Bool; let sources: [Source]; let start: Double }
    enum Event { case progress(Double, Double, FlexID), closed(Double, Double, FlexID) }

    var onEvent: ((Event) -> Void)?
    var onZap: ((Int) -> Void)?   // direct : haut / bas = chaîne précédente / suivante
    var onDismiss: (() -> Void)?
    private var item: Item?
    private var timer: Timer?

    func load(_ it: Item) {
        item = it
        guard let s = it.sources.first, let url = URL(string: s.url) else { return }
        let p = AVPlayer(url: url)
        if it.start > 1 { p.seek(to: CMTime(seconds: it.start, preferredTimescale: 600)) }
        player = p
        p.play()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.report(closed: false) }
    }

    private func report(closed: Bool) {
        guard let p = player, let it = item, let src = it.sources.first else { return }
        let pos = p.currentTime().seconds, dur = p.currentItem?.duration.seconds ?? 0
        guard pos.isFinite, dur.isFinite else { return }
        onEvent?(closed ? .closed(pos, dur, src.id) : .progress(pos, dur, src.id))
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed {
            report(closed: true)
            timer?.invalidate()
            player?.pause()
            onDismiss?()
        }
    }
}

@MainActor
enum PlayerPresenter {
    private static var current: PlayerViewController?

    static var isOpen: Bool { current?.presentingViewController != nil }

    static func closeIfOpen() {
        if let p = current, p.presentingViewController != nil { p.dismiss(animated: true) }
    }

    static func present(_ item: PlayerViewController.Item, onZap: ((Int) -> Void)? = nil, onEvent: @escaping (PlayerViewController.Event) -> Void) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let p = PlayerViewController()
        p.onEvent = onEvent
        p.onZap = onZap
        p.onDismiss = { current = nil }
        p.load(item)
        current = p
        top.present(p, animated: true)
    }
}
#endif

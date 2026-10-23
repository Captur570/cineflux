import UIKit
import AVKit

/// Direct en HLS (.m3u8) avec le lecteur de l'Apple TV : démarrage rapide, interface native
/// (glisser vers le bas pour les infos, langues et sous-titres du flux).
/// Si le flux ne démarre pas, VLC prend le relais (onFail).
final class LivePlayer: AVPlayerViewController {
    private static weak var current: LivePlayer?

    private var onClose: (() -> Void)?
    private var onFail: (() -> Void)?
    private var statusObs: NSKeyValueObservation?
    private var watchdog: Timer?
    private var failed = false
    private var started = false

    @MainActor
    static func present(url: URL, title: String, subtitle: String, onClose: @escaping () -> Void, onFail: @escaping () -> Void) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let p = LivePlayer()
        p.onClose = onClose
        p.onFail = onFail
        p.start(url: url, title: title, subtitle: subtitle)
        current = p
        top.present(p, animated: true)
    }

    @MainActor
    static func closeIfOpen() {
        if let p = current, p.presentingViewController != nil { p.dismiss(animated: true) }
    }

    private func start(url: URL, title: String, subtitle: String) {
        let item = AVPlayerItem(url: url)
        item.externalMetadata = [meta(.commonIdentifierTitle, title), meta(.iTunesMetadataTrackSubTitle, subtitle)]
        let pl = AVPlayer(playerItem: item)
        player = pl
        statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                if it.status == .failed { NSLog("[direct] lecteur Apple : échec %@", it.error?.localizedDescription ?? "?"); self?.fail() }
                if it.status == .readyToPlay { NSLog("[direct] lecteur Apple : lecture"); self?.started = true }
            }
        }
        // pas d'image au bout de 12 s : on passe à VLC
        watchdog = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            guard let self, !self.started || self.player?.currentItem?.status != .readyToPlay else { return }
            NSLog("[direct] lecteur Apple : rien au bout de 12 s, VLC prend le relais")
            self.fail()
        }
        pl.play()
    }

    private func meta(_ id: AVMetadataIdentifier, _ value: String) -> AVMetadataItem {
        let m = AVMutableMetadataItem()
        m.identifier = id
        m.value = value as NSString
        m.extendedLanguageTag = "und"
        return m
    }

    private func fail() {
        guard !failed else { return }
        failed = true
        watchdog?.invalidate()
        player?.pause()
        let cb = onFail
        dismiss(animated: false) { cb?() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed else { return }
        watchdog?.invalidate()
        statusObs = nil
        player?.pause()
        player = nil
        if !failed { onClose?() }
    }
}

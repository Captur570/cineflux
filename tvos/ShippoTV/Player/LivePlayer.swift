import UIKit
import AVKit

/// Direct en HLS (.m3u8) avec le lecteur de l'Apple TV : démarrage rapide, interface native
/// (glisser vers le bas pour les infos, langues et sous-titres du flux).
/// Si le flux ne démarre pas, ou ne donne que le son (vidéo HEVC/4K), VLC prend le relais (onFail).
final class LivePlayer: AVPlayerViewController {
    private static weak var current: LivePlayer?

    private var onClose: (() -> Void)?
    private var onFail: (() -> Void)?
    private var onNoImage: (() -> Void)?
    private var onZap: ((Int) -> Void)?
    private var statusObs: NSKeyValueObservation?
    private var watchdog: Timer?
    private var failed = false
    private var started = false
    // détection « du son mais pas d'image » (flux HEVC/4K que le lecteur Apple ne décode pas)
    private let videoOut = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
    private var sawFrame = false
    private var frameCheck: Timer?
    private var firstTime: Double?

    @MainActor
    static func present(url: URL, title: String, subtitle: String, onNoImage: (() -> Void)? = nil, onZap: ((Int) -> Void)? = nil,
                        onClose: @escaping () -> Void, onFail: @escaping () -> Void) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let p = LivePlayer()
        p.onClose = onClose
        p.onFail = onFail
        p.onNoImage = onNoImage
        p.onZap = onZap
        p.start(url: url, title: title, subtitle: subtitle)
        current = p
        top.present(p, animated: true)
    }

    @MainActor static var isOpen: Bool { current?.presentingViewController != nil }

    @MainActor
    static func closeIfOpen() {
        if let p = current, p.presentingViewController != nil { p.dismiss(animated: true) }
    }

    private func start(url: URL, title: String, subtitle: String) {
        let item = AVPlayerItem(url: url)
        item.externalMetadata = [meta(.commonIdentifierTitle, title), meta(.iTunesMetadataTrackSubTitle, subtitle)]
        item.add(videoOut)
        let pl = AVPlayer(playerItem: item)
        player = pl
        // menu du lecteur (glisser vers le bas) : bascule manuelle sur VLC
        transportBarCustomMenuItems = [UIAction(title: "Ouvrir avec VLC", image: UIImage(systemName: "arrow.triangle.2.circlepath")) { [weak self] _ in
            self?.fail(reason: "demandé")
        }]
        frameCheck = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkFrames() }
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
            self.fail(reason: "délai")
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

    /// Le son avance depuis 5 s sans une seule image : le lecteur Apple ne sait pas décoder la vidéo.
    private func checkFrames() {
        guard !failed, let pl = player, let item = pl.currentItem else { return }
        let t = videoOut.itemTime(forHostTime: CACurrentMediaTime())
        if videoOut.hasNewPixelBuffer(forItemTime: t) {
            _ = videoOut.copyPixelBuffer(forItemTime: t, itemTimeForDisplay: nil)
            sawFrame = true
        }
        if sawFrame || item.presentationSize != .zero { frameCheck?.invalidate(); return }
        let now = pl.currentTime().seconds
        guard now.isFinite, pl.timeControlStatus == .playing else { return }
        if firstTime == nil { firstTime = now }
        if let f = firstTime, now - f > 5 {
            NSLog("[direct] lecteur Apple : du son mais pas d'image, VLC prend le relais")
            fail(reason: "pas d'image")
        }
    }

    private func fail(reason: String = "échec") {
        guard !failed else { return }
        failed = true
        frameCheck?.invalidate()
        if reason == "pas d'image" { onNoImage?() }
        watchdog?.invalidate()
        player?.pause()
        let cb = onFail
        dismiss(animated: false) { cb?() }
    }

    /// Haut / bas sur la télécommande : chaîne précédente / suivante (comme sur une télé).
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let t = presses.first?.type, t == .upArrow || t == .downArrow, let z = onZap {
            z(t == .upArrow ? -1 : 1)
            return
        }
        super.pressesBegan(presses, with: event)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed else { return }
        watchdog?.invalidate()
        frameCheck?.invalidate()
        statusObs = nil
        player?.pause()
        player = nil
        if !failed { onClose?() }
    }
}

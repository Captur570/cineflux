#if canImport(VLCKit) || canImport(TVVLCKit)
import UIKit
#if canImport(VLCKit)
import VLCKit            // VLC 4 : sous-titres dans les bandes noires
#else
import TVVLCKit          // repli : VLC 3 pour tvOS
#endif

/// Lecteur plein écran de l'Apple TV (VLC : MKV, TS, HLS, AC3/DTS, 4K…), piloté à la télécommande Siri :
///  - clic au centre / Lecture-Pause : pause ou reprise ;
///  - clic à gauche / à droite du pavé : -10 s / +10 s ;
///  - glisser le doigt sur le pavé : avance ou recul rapide (relâcher pour aller à la position) ;
///  - clic en bas : langue, sous-titres, version ;  clic en haut : informations ;
///  - bouton Retour (‹ ou MENU) : fermer.
/// Une coupure en plein film relance la même version au même endroit (jusqu'à 3 fois).
final class PlayerViewController: UIViewController {
    struct Source { let url: String; let label: String; let id: FlexID }
    struct Item { let title: String; let subtitle: String; let live: Bool; let sources: [Source]; let start: Double }
    enum Event { case progress(Double, Double, FlexID), closed(Double, Double, FlexID) }

    var onEvent: ((Event) -> Void)?
    var onDismiss: (() -> Void)?

    private let mp = VLCMediaPlayer()
    private let videoView = UIView()
    private var item: Item!
    private var idx = 0
    private var lastPos: Double = 0
    private var length: Double = 0
    private var retries = 0
    private var retryAt: Double = 0
    private var playedOnce = false
    private var played = false
    private var loadTime = Date()
    private var lastSave = Date()
    private var closing = false
    private var failing = false
    private var pollTimer: Timer?
    private var hideTimer: Timer?
    private var scrubBase: Double?
    private var scrubTarget: Double = 0

    // interface
    private let accent = UIColor(red: 214 / 255, green: 55 / 255, blue: 95 / 255, alpha: 1)
    private let topShade = CAGradientLayer()
    private let bottomShade = CAGradientLayer()
    private let titleLabel = UILabel()
    private let subLabel = UILabel()
    private let resBadge = PaddedLabel()
    private let bar = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
    private let track = UIView()
    private let fill = UIView()
    private let knob = UIView()
    private let timeLabel = UILabel()
    private let endLabel = UILabel()
    private let hintLabel = UILabel()
    private let bigIcon = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let msgLabel = UILabel()
    private var controlsVisible = true

    // MARK: - Contenu

    func load(_ it: Item) {
        loadViewIfNeeded()
        item = it
        titleLabel.text = it.title
        subLabel.text = it.subtitle
        played = false
        playedOnce = false
        retries = 0
        lastPos = 0
        length = 0
        resBadge.isHidden = true
        open(0, at: it.start)
        showControls()
    }

    private func open(_ i: Int, at: Double) {
        guard i < item.sources.count, let url = URL(string: item.sources[i].url) else {
            showMessage("Aucune source ne répond pour le moment.")
            return
        }
        idx = i
        hideMessage()
        spinner.startAnimating()
        #if canImport(VLCKit)
        guard let m = VLCMedia(url: url) else { showMessage("Adresse de la vidéo invalide."); return }
        #else
        let m = VLCMedia(url: url)
        #endif
        m.addOption(":network-caching=\(item.live ? 2500 : 1500)")
        m.addOption(":http-reconnect")
        if at > 1 { m.addOption(":start-time=\(Int(at))") }
        mp.media = m
        mp.play()
        loadTime = Date()
        played = false
    }

    // MARK: - Cycle de vie

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        videoView.isUserInteractionEnabled = false
        view.addSubview(videoView)
        mp.drawable = videoView
        buildUI()
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        view.addGestureRecognizer(pan)
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        topShade.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 260)
        bottomShade.frame = CGRect(x: 0, y: view.bounds.height - 360, width: view.bounds.width, height: 360)
        layoutTrack()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || closing {
            pollTimer?.invalidate()
            hideTimer?.invalidate()
            onDismiss?()
        }
    }

    // MARK: - Boucle d'état (toutes les 250 ms)

    private func tick() {
        guard !closing, item != nil else { return }
        let st = mp.state
        let t = Double(mp.time.intValue) / 1000
        if let len = mp.media?.length.intValue, len > 0 { length = Double(len) / 1000 }
        if mp.isPlaying && t > 0 {
            lastPos = t
            if !played {
                played = true
                playedOnce = true
                spinner.stopAnimating()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.showResolution() }
            }
            if retries > 0 && t - retryAt > 90 { retries = 0 }
        }
        #if canImport(VLCKit)
        let isEnd = st == .stopped
        let isLoading = st == .opening
        #else
        let isEnd = st == .ended || st == .stopped
        let isLoading = st == .opening || st == .buffering
        #endif
        if st == .error {
            fail()
        } else if isEnd {
            if played && !closing { finishedOrCut() }
        } else if isLoading {
            if !mp.isPlaying { spinner.startAnimating() }
            if !played && Date().timeIntervalSince(loadTime) > 20 { fail() }
        } else if mp.isPlaying {
            spinner.stopAnimating()
        }
        if scrubBase == nil { updateTimes(lastPos) }
        if Date().timeIntervalSince(lastSave) > 10 && played && !item.live {
            lastSave = Date()
            onEvent?(.progress(lastPos, length, item.sources[idx].id))
        }
    }

    private func finishedOrCut() {
        if !item.live && length > 60 && lastPos < length * 0.9 { fail(); return }   // « fin » bien avant la fin : coupure
        if item.live { fail(); return }
        close()
    }

    private func fail() {
        guard !failing, !closing else { return }
        failing = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.failing = false }
        if playedOnce && retries < 3 {
            retries += 1
            let at = item.live ? 0 : max(0, lastPos - 2)
            retryAt = at
            showMessage("Coupure du flux, reprise…", auto: true)
            let i = idx
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7 * Double(retries)) { [weak self] in
                guard let self = self, !self.closing else { return }
                self.open(i, at: at)
            }
            return
        }
        if !playedOnce && idx + 1 < item.sources.count {
            showMessage("Source indisponible, essai : \(item.sources[idx + 1].label)", auto: true)
            open(idx + 1, at: item.start)
            return
        }
        mp.stop()
        spinner.stopAnimating()
        showMessage(playedOnce ? "La lecture s'est interrompue : le serveur ne répond plus pour cette version.\nAppuyez au centre pour réessayer."
                               : "Lecture impossible : aucune source ne répond pour le moment.\nAppuyez au centre pour réessayer.")
    }

    // MARK: - Télécommande

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let p = presses.first else { return super.pressesBegan(presses, with: event) }
        switch p.type {
        case .menu:
            close()
        case .playPause:
            togglePlay()
        case .select:
            if !msgLabel.isHidden && !mp.isPlaying && !spinner.isAnimating { retries = 0; open(idx, at: max(0, lastPos - 2)) }
            else { togglePlay() }
        case .leftArrow:
            seek(-10)
        case .rightArrow:
            seek(10)
        case .downArrow:
            showOptions()
        case .upArrow:
            showControls()
        default:
            super.pressesBegan(presses, with: event)
        }
    }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        guard !item.live, length > 0 else { return }
        let tx = g.translation(in: view).x
        switch g.state {
        case .began:
            scrubBase = lastPos
            showControls(autoHide: false)
        case .changed:
            guard let base = scrubBase else { return }
            // un glissement sur toute la largeur du pavé ≈ 6 minutes (ou tout le film s'il est court)
            let span = min(length, 360)
            scrubTarget = min(max(0, base + Double(tx / view.bounds.width) * span * 2.2), max(0, length - 2))
            updateTimes(scrubTarget)
            hintLabel.text = (scrubTarget >= base ? "⏩  " : "⏪  ") + clock(scrubTarget) + "   ·   relâchez pour y aller"
            hintLabel.isHidden = false
        case .ended:
            if scrubBase != nil { jump(to: scrubTarget) }
            scrubBase = nil
            hintLabel.isHidden = true
            showControls()
        default:
            scrubBase = nil
            hintLabel.isHidden = true
        }
    }

    private func togglePlay() {
        if mp.isPlaying {
            mp.pause()
            flash("pause.fill")
            showControls(autoHide: false)
        } else {
            mp.play()
            flash("play.fill")
            showControls()
        }
    }

    private func seek(_ d: Double) {
        guard !item.live, length > 0 else { return }
        jump(to: min(max(0, lastPos + d), length - 1))
        flash(d < 0 ? "gobackward.10" : "goforward.10")
        showControls()
    }

    private func jump(to t: Double) {
        mp.time = VLCTime(number: NSNumber(value: Int32(t * 1000)))
        lastPos = t
        updateTimes(t)
    }

    /// Fermeture demandée de l'extérieur (arrêt depuis un autre appareil) : même chemin que le bouton Retour.
    func closeFromApp() { close() }

    private func close() {
        guard !closing else { return }
        closing = true
        onEvent?(.closed(lastPos, length, item.sources[idx].id))
        mp.stop()
        pollTimer?.invalidate()
        dismiss(animated: true)
    }

    // MARK: - Options : langue, sous-titres, version

    private func showOptions() {
        showControls(autoHide: false)
        let a = UIAlertController(title: item.title, message: nil, preferredStyle: .actionSheet)
        let audio = audioTracks()
        if audio.count > 1 { a.addAction(UIAlertAction(title: "Langue : \(audio.first { $0.on }?.name ?? "—")", style: .default) { _ in self.pick("Langue", audio) }) }
        let subs = subtitleTracks()
        if subs.count > 1 { a.addAction(UIAlertAction(title: "Sous-titres : \(subs.first { $0.on }?.name ?? "Aucun")", style: .default) { _ in self.pick("Sous-titres", subs) }) }
        if item.sources.count > 1 {
            a.addAction(UIAlertAction(title: "Version : \(item.sources[idx].label)", style: .default) { _ in
                let opts = self.item.sources.enumerated().map { k, s in
                    Track(name: s.label, on: k == self.idx) {
                        self.retries = 0
                        self.open(k, at: self.item.live ? 0 : max(0, self.lastPos - 2))
                    }
                }
                self.pick("Version", opts)
            })
        }
        if a.actions.isEmpty { a.message = "Pas d'autre langue, sous-titre ou version pour cette vidéo." }
        a.addAction(UIAlertAction(title: "Fermer", style: .cancel))
        present(a, animated: true)
    }

    private struct Track { let name: String; let on: Bool; let select: () -> Void }

    private func pick(_ title: String, _ tracks: [Track]) {
        let a = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
        for t in tracks { a.addAction(UIAlertAction(title: (t.on ? "✓  " : "") + t.name, style: .default) { _ in t.select() }) }
        a.addAction(UIAlertAction(title: "Annuler", style: .cancel))
        present(a, animated: true)
    }

    private func audioTracks() -> [Track] {
        #if canImport(VLCKit)
        return mp.audioTracks.map { t in Track(name: t.trackName, on: t.isSelected) { t.isSelectedExclusively = true } }
        #else
        let names = (mp.audioTrackNames as? [String]) ?? []
        let ids = (mp.audioTrackIndexes as? [NSNumber]) ?? []
        return zip(names, ids).filter { $0.1.int32Value >= 0 }.map { n, i in
            Track(name: n, on: i.int32Value == mp.currentAudioTrackIndex) { self.mp.currentAudioTrackIndex = i.int32Value }
        }
        #endif
    }

    private func subtitleTracks() -> [Track] {
        #if canImport(VLCKit)
        let tt = mp.textTracks
        return [Track(name: "Aucun", on: !tt.contains { $0.isSelected }) { self.mp.deselectAllTextTracks() }]
            + tt.map { t in Track(name: t.trackName, on: t.isSelected) { t.isSelectedExclusively = true } }
        #else
        let names = (mp.videoSubTitlesNames as? [String]) ?? []
        let ids = (mp.videoSubTitlesIndexes as? [NSNumber]) ?? []
        return zip(names, ids).map { n, i in
            Track(name: i.int32Value < 0 ? "Aucun" : n, on: i.int32Value == mp.currentVideoSubTitleIndex) { self.mp.currentVideoSubTitleIndex = i.int32Value }
        }
        #endif
    }

    // MARK: - Affichage

    private func showResolution() {
        let size = mp.videoSize
        guard size.width > 0, size.height > 0 else { return }
        let p = min(size.width * 9 / 16, size.height)
        resBadge.text = size.width >= 3200 || p >= 1800 ? "4K" : p >= 1000 ? "1080p" : p >= 700 ? "720p" : "\(Int(p))p"
        resBadge.isHidden = false
    }

    private func updateTimes(_ pos: Double) {
        if item?.live == true {
            timeLabel.text = "● DIRECT"
            endLabel.text = ""
            fill.frame.size.width = track.bounds.width
            knob.isHidden = true
            return
        }
        guard length > 0 else { timeLabel.text = clock(pos); endLabel.text = ""; return }
        timeLabel.text = clock(pos)
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        endLabel.text = "-" + clock(length - pos) + "   ·   fin à " + f.string(from: Date().addingTimeInterval(length - pos))
        let w = track.bounds.width * CGFloat(min(1, max(0, pos / length)))
        fill.frame = CGRect(x: 0, y: 0, width: w, height: track.bounds.height)
        knob.isHidden = false
        knob.center = CGPoint(x: track.frame.minX + w, y: track.frame.midY)
    }

    private func showControls(autoHide: Bool = true) {
        controlsVisible = true
        UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState]) {
            for v in self.overlayViews { v.alpha = 1 }
            self.bar.transform = .identity
        }
        hideTimer?.invalidate()
        guard autoHide else { return }
        hideTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
            guard let self = self, self.mp.isPlaying, self.scrubBase == nil else { return }
            self.hideControls()
        }
    }

    private func hideControls() {
        controlsVisible = false
        UIView.animate(withDuration: 0.45, delay: 0, options: [.beginFromCurrentState]) {
            for v in self.overlayViews { v.alpha = 0 }
            self.bar.transform = CGAffineTransform(translationX: 0, y: 30)
        }
    }

    private var overlayViews: [UIView] { [titleLabel, subLabel, resBadge, bar, timeLabel, endLabel, knob, topShadeView, bottomShadeView] }
    private let topShadeView = UIView()
    private let bottomShadeView = UIView()

    private func flash(_ symbol: String) {
        bigIcon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 90, weight: .bold))
        bigIcon.alpha = 1
        bigIcon.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0.5, options: []) {
            self.bigIcon.transform = .identity
        }
        UIView.animate(withDuration: 0.4, delay: 0.5, options: []) { self.bigIcon.alpha = 0 }
    }

    private func showMessage(_ text: String, auto: Bool = false) {
        msgLabel.text = text
        msgLabel.isHidden = false
        if auto {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self = self, self.msgLabel.text == text else { return }
                self.hideMessage()
            }
        }
    }

    private func hideMessage() { msgLabel.isHidden = true }

    private func clock(_ s: Double) -> String {
        let t = Int(max(0, s))
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }

    // MARK: - Construction

    private func layoutTrack() {
        let m: CGFloat = 90
        bar.frame = CGRect(x: m - 30, y: view.bounds.height - 190, width: view.bounds.width - 2 * (m - 30), height: 130)
        track.frame = CGRect(x: 30, y: 30, width: bar.bounds.width - 60, height: 10)
        timeLabel.frame = CGRect(x: 30, y: 58, width: 400, height: 44)
        endLabel.frame = CGRect(x: bar.bounds.width - 30 - 900, y: 58, width: 900, height: 44)
        updateTimes(scrubBase != nil ? scrubTarget : lastPos)
    }

    private func buildUI() {
        topShade.colors = [UIColor.black.withAlphaComponent(0.75).cgColor, UIColor.clear.cgColor]
        bottomShade.colors = [UIColor.clear.cgColor, UIColor.black.withAlphaComponent(0.8).cgColor]
        topShadeView.frame = view.bounds
        topShadeView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        topShadeView.isUserInteractionEnabled = false
        topShadeView.layer.addSublayer(topShade)
        bottomShadeView.frame = view.bounds
        bottomShadeView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        bottomShadeView.isUserInteractionEnabled = false
        bottomShadeView.layer.addSublayer(bottomShade)
        view.addSubview(topShadeView)
        view.addSubview(bottomShadeView)

        titleLabel.font = .systemFont(ofSize: 52, weight: .heavy)
        titleLabel.textColor = .white
        subLabel.font = .systemFont(ofSize: 28, weight: .semibold)
        subLabel.textColor = UIColor.white.withAlphaComponent(0.75)
        resBadge.font = .systemFont(ofSize: 22, weight: .heavy)
        resBadge.textColor = .white
        resBadge.backgroundColor = accent
        resBadge.layer.cornerRadius = 10
        resBadge.clipsToBounds = true
        resBadge.isHidden = true
        let titles = UIStackView(arrangedSubviews: [titleLabel, subLabel])
        titles.axis = .vertical
        titles.spacing = 4
        let top = UIStackView(arrangedSubviews: [titles, resBadge])
        top.axis = .horizontal
        top.alignment = .center
        top.spacing = 24
        top.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(top)
        NSLayoutConstraint.activate([
            top.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 90),
            top.topAnchor.constraint(equalTo: view.topAnchor, constant: 70),
            top.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -90),
        ])

        bar.layer.cornerRadius = 32
        bar.layer.cornerCurve = .continuous
        bar.clipsToBounds = true
        bar.layer.borderWidth = 1
        bar.layer.borderColor = UIColor.white.withAlphaComponent(0.2).cgColor
        view.addSubview(bar)
        track.backgroundColor = UIColor.white.withAlphaComponent(0.25)
        track.layer.cornerRadius = 5
        track.clipsToBounds = true
        fill.backgroundColor = accent
        track.addSubview(fill)
        bar.contentView.addSubview(track)
        knob.frame = CGRect(x: 0, y: 0, width: 26, height: 26)
        knob.backgroundColor = .white
        knob.layer.cornerRadius = 13
        bar.contentView.addSubview(knob)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 30, weight: .bold)
        timeLabel.textColor = .white
        endLabel.font = .monospacedDigitSystemFont(ofSize: 26, weight: .semibold)
        endLabel.textColor = UIColor.white.withAlphaComponent(0.75)
        endLabel.textAlignment = .right
        bar.contentView.addSubview(timeLabel)
        bar.contentView.addSubview(endLabel)

        hintLabel.font = .systemFont(ofSize: 34, weight: .bold)
        hintLabel.textColor = .white
        hintLabel.textAlignment = .center
        hintLabel.isHidden = true
        hintLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hintLabel)
        bigIcon.tintColor = .white
        bigIcon.alpha = 0
        bigIcon.contentMode = .center
        bigIcon.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bigIcon)
        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        msgLabel.font = .systemFont(ofSize: 32, weight: .semibold)
        msgLabel.textColor = .white
        msgLabel.numberOfLines = 0
        msgLabel.textAlignment = .center
        msgLabel.isHidden = true
        msgLabel.backgroundColor = UIColor(white: 0.08, alpha: 0.85)
        msgLabel.layer.cornerRadius = 24
        msgLabel.clipsToBounds = true
        msgLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(msgLabel)
        NSLayoutConstraint.activate([
            hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hintLabel.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -230),
            bigIcon.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bigIcon.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            msgLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            msgLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            msgLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 1100),
            msgLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 700),
        ])
    }
}

/// Étiquette avec marges intérieures (badge de qualité).
final class PaddedLabel: UILabel {
    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)))
    }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + 28, height: s.height + 12)
    }
}

/// Affiche le lecteur au-dessus de l'interface SwiftUI (il reçoit alors directement la télécommande).
@MainActor
enum PlayerPresenter {
    private static var current: PlayerViewController?

    static func closeIfOpen() {
        if let p = current, p.presentingViewController != nil { p.closeFromApp() }
    }

    static func present(_ item: PlayerViewController.Item, onEvent: @escaping (PlayerViewController.Event) -> Void) {
        if let p = current, p.presentingViewController != nil {
            p.load(item)
            return
        }
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let p = PlayerViewController()
        p.modalPresentationStyle = .fullScreen
        p.onEvent = onEvent
        p.onDismiss = { current = nil }
        p.load(item)
        current = p
        top.present(p, animated: true)
    }
}
#endif

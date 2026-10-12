import UIKit
import MobileVLCKit

/// Lecteur plein écran (VLC : MKV, TS, HLS, AC3/DTS, 4K…) habillé dans le style de ShippoTV :
/// commandes en verre, barre de progression bordeaux, carte « Épisode suivant ».
/// Une coupure en plein film relance la même version au même endroit (jusqu'à 3 fois).
final class PlayerViewController: UIViewController {
    var onEvent: (([String: Any]) -> Void)?
    var onDismiss: (() -> Void)?

    private let mp: VLCMediaPlayer = {
        // essai (fabrication GitHub) : position des sous-titres réglée pour tout le lecteur
        let env = ProcessInfo.processInfo.environment
        if let m = env["SHIPPO_SUBLIB"], !m.isEmpty { return VLCMediaPlayer(options: [m]) }
        return VLCMediaPlayer()
    }()
    private let videoView = UIView()
    private var streams: [[String: Any]] = []
    private var idx = 0
    private var live = false
    private var hasNext = false
    private var nextLabel = ""
    private var startAt: Double = 0
    private var lastPos: Double = 0          // secondes
    private var length: Double = 0           // secondes
    private var retries = 0
    private var retryAt: Double = 0
    private var playedOnce = false
    private var played = false
    private var loadTime = Date()
    private var lastSave = Date()
    private var closing = false
    private var ended = false
    private var scrubbing = false
    private var pollTimer: Timer?
    private var hideTimer: Timer?

    // interface
    private let accent = UIColor(red: 214 / 255, green: 55 / 255, blue: 95 / 255, alpha: 1)
    private let topBar = PassThroughStack()
    private let closeBtn = UIButton(type: .system)
    private let titleBox = GlassView(radius: 20)
    private let titleLabel = UILabel()
    private let subLabel = UILabel()
    private let resBadge = PaddedLabel()
    private let bottomBar = GlassView(radius: 28)
    private let playBtn = UIButton(type: .system)
    private let backBtn = UIButton(type: .system)
    private let fwdBtn = UIButton(type: .system)
    private let slider = UISlider()
    private let timeLabel = UILabel()
    private let audioBtn = UIButton(type: .system)
    private let subsBtn = UIButton(type: .system)
    private let srcBtn = UIButton(type: .system)
    private let nextBtn = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .large)
    private let msgBox = GlassView(radius: 22)
    private let msgLabel = UILabel()
    private let msgRetry = UIButton(type: .system)
    private let upNext = GlassView(radius: 22)
    private let upLabel = UILabel()
    private var controlsVisible = true
    // gestes : 1 tap = commandes, 2 taps = ±10 s, 3 taps = ±30 s
    private let touchLayer = UIView()
    private var tapCount = 0
    private var tapPoint = CGPoint.zero
    private var tapTimer: Timer?
    private let seekBubble = GlassView(radius: 60)
    private let seekLabel = UILabel()
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    // MARK: - Contenu

    func load(_ p: [String: Any]) {
        loadViewIfNeeded()
        sendProgress(final: true)
        streams = (p["streams"] as? [[String: Any]]) ?? []
        live = (p["live"] as? Bool) ?? false
        hasNext = (p["next"] as? Bool) ?? false
        nextLabel = (p["nextLabel"] as? String) ?? ""
        startAt = (p["start"] as? NSNumber)?.doubleValue ?? 0
        titleLabel.text = (p["title"] as? String) ?? ""
        subLabel.text = (p["sub"] as? String) ?? ""
        subLabel.isHidden = (subLabel.text ?? "").isEmpty
        playedOnce = false
        ended = false
        retries = 0
        lastPos = 0
        length = 0
        resBadge.isHidden = true
        upNext.isHidden = true
        nextBtn.isHidden = !hasNext
        backBtn.setImage(UIImage(systemName: live ? "chevron.backward.2" : "gobackward.10"), for: .normal)
        fwdBtn.setImage(UIImage(systemName: live ? "chevron.forward.2" : "goforward.30"), for: .normal)
        slider.isHidden = live
        rebuildSourceMenu()
        open(0, at: startAt)
        showControls()
    }

    private func open(_ i: Int, at: Double) {
        guard i < streams.count, let s = streams[i]["url"] as? String, let url = URL(string: s) else {
            showMessage("Aucune source ne répond pour le moment.")
            return
        }
        idx = i
        hideMessage()
        spinner.startAnimating()
        let m = VLCMedia(url: url)
        m.addOption(":network-caching=\(live ? 2500 : 1500)")
        m.addOption(":http-reconnect")
        if let extra = ProcessInfo.processInfo.environment["SHIPPO_MEDIAOPTS"], !extra.isEmpty {
            for o in extra.components(separatedBy: "|") where !o.isEmpty { m.addOption(o) }
        }
        if at > 1 { m.addOption(":start-time=\(Int(at))") }
        mp.media = m
        mp.play()
        loadTime = Date()
        played = false
        rebuildSourceMenu()
    }

    // MARK: - Cycle de vie

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.backgroundColor = .black
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)
        mp.drawable = videoView
        // la vue vidéo de VLC garde les touchers pour elle : on pose une couche tactile au-dessus
        videoView.isUserInteractionEnabled = false
        touchLayer.frame = view.bounds
        touchLayer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        touchLayer.backgroundColor = .clear
        view.addSubview(touchLayer)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        touchLayer.addGestureRecognizer(tap)
        buildUI()
        buildSeekBubble()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
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
        guard !closing else { return }
        let st = mp.state
        let t = Double(mp.time.intValue) / 1000
        if let len = mp.media?.length.intValue, len > 0 { length = Double(len) / 1000 }
        if mp.isPlaying && t > 0 {
            lastPos = t
            if !played {
                played = true
                playedOnce = true
                spinner.stopAnimating()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.showResolution() ; self?.rebuildTrackMenus() }
            }
            if retries > 0 && t - retryAt > 90 { retries = 0 }
        }
        switch st {
        case .error:
            fail()
        case .ended, .stopped:
            if played && !closing { finishedOrCut() }
        case .opening, .buffering:
            if !mp.isPlaying { spinner.startAnimating() }
            if !played && Date().timeIntervalSince(loadTime) > 20 { fail() }
        default:
            if mp.isPlaying { spinner.stopAnimating() }
        }
        playBtn.setImage(UIImage(systemName: mp.isPlaying ? "pause.fill" : "play.fill"), for: .normal)
        if !live && !scrubbing && length > 0 {
            slider.value = Float(lastPos / length)
            timeLabel.text = "\(clock(lastPos)) / \(clock(length))" + endTime()
        } else if live {
            timeLabel.text = "● DIRECT"
        }
        // carte « Épisode suivant » dans les 25 dernières secondes
        let rem = length - lastPos
        if hasNext && !live && length > 60 && rem > 0 && rem < 25 {
            upNext.isHidden = false
            upLabel.text = "Épisode suivant\n\(nextLabel)\nDans \(Int(rem.rounded(.up))) s"
        } else {
            upNext.isHidden = true
        }
        if Date().timeIntervalSince(lastSave) > 10 && played && !live {
            lastSave = Date()
            onEvent?(["type": "progress", "pos": lastPos, "dur": length, "idx": idx])
        }
    }

    private func finishedOrCut() {
        if !live && length > 60 && lastPos < length * 0.9 {
            fail()                                   // « fin » bien avant la fin : coupure réseau
            return
        }
        if live { fail(); return }
        guard !ended else { return }
        ended = true
        onEvent?(["type": "ended", "pos": length, "dur": length, "idx": idx])
    }

    private var failing = false
    private func fail() {
        guard !failing, !closing else { return }
        failing = true
        defer { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.failing = false } }
        if playedOnce && retries < 3 {
            retries += 1
            let at = live ? 0 : max(0, lastPos - 2)
            retryAt = at
            showMessage("Coupure du flux, reprise…", retry: false)
            let i = idx
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7 * Double(retries)) { [weak self] in
                guard let self = self, !self.closing else { return }
                self.open(i, at: at)
            }
            return
        }
        if !playedOnce && idx + 1 < streams.count {
            let label = (streams[idx + 1]["label"] as? String) ?? "source suivante"
            showMessage("Source indisponible, essai : \(label)", retry: false)
            open(idx + 1, at: startAt)
            return
        }
        mp.stop()
        spinner.stopAnimating()
        showMessage(playedOnce ? "La lecture s'est interrompue : le serveur ne répond plus pour cette version."
                               : "Lecture impossible : aucune source ne répond pour le moment.", retry: true)
    }

    // MARK: - Actions

    @objc private func togglePlay() {
        if mp.isPlaying { mp.pause() } else { mp.play() }
        showControls()
    }

    @objc private func back() {
        if live { onEvent?(["type": "zap", "d": -1]) } else { seek(-10) }
        showControls()
    }

    @objc private func fwd() {
        if live { onEvent?(["type": "zap", "d": 1]) } else { seek(30) }
        showControls()
    }

    private func seek(_ d: Double) {
        guard length > 0 else { return }
        if Thread.isMainThread { haptic.impactOccurred(intensity: 0.6) }
        let t = min(max(0, lastPos + d), length - 1)
        mp.time = VLCTime(int: Int32(t * 1000))
        lastPos = t
    }

    @objc private func sliderBegan() { scrubbing = true; hideTimer?.invalidate() }
    @objc private func sliderMoved() {
        guard length > 0 else { return }
        timeLabel.text = "\(clock(Double(slider.value) * length)) / \(clock(length))"
    }
    @objc private func sliderEnded() {
        scrubbing = false
        guard length > 0 else { return }
        let t = Double(slider.value) * length
        mp.time = VLCTime(int: Int32(t * 1000))
        lastPos = t
        showControls()
    }

    @objc private func goNext() {
        onEvent?(["type": "next", "pos": lastPos, "dur": length, "idx": idx])
    }

    @objc private func retryTapped() {
        retries = 0
        open(idx, at: max(0, lastPos - 2))
    }

    @objc private func closeTapped() {
        close(notify: true)
    }

    /// Fermeture demandée par l'interface (fin de série, arrêt à distance…).
    func closeFromApp() {
        close(notify: true)
    }

    private func close(notify: Bool) {
        guard !closing else { return }
        closing = true
        if notify { onEvent?(["type": "closed", "pos": lastPos, "dur": length, "idx": idx]) }
        mp.stop()
        pollTimer?.invalidate()
        dismiss(animated: true)
    }

    private func sendProgress(final: Bool) {
        guard played, !live, length > 0 else { return }
        onEvent?(["type": "progress", "pos": lastPos, "dur": length, "idx": idx])
    }

    // MARK: - Menus (pistes audio, sous-titres, version)

    private func rebuildTrackMenus() {
        let names = (mp.audioTrackNames as? [String]) ?? []
        let ids = (mp.audioTrackIndexes as? [NSNumber]) ?? []
        let cur = mp.currentAudioTrackIndex
        let audio = zip(names, ids).filter { $0.1.int32Value >= 0 }.map { n, i in
            UIAction(title: n, state: i.int32Value == cur ? .on : .off) { [weak self] _ in
                self?.mp.currentAudioTrackIndex = i.int32Value
                self?.rebuildTrackMenus()
            }
        }
        audioBtn.menu = UIMenu(title: "Langue", children: audio)
        audioBtn.isHidden = audio.count < 2
        let snames = (mp.videoSubTitlesNames as? [String]) ?? []
        let sids = (mp.videoSubTitlesIndexes as? [NSNumber]) ?? []
        let scur = mp.currentVideoSubTitleIndex
        let subs = zip(snames, sids).map { n, i in
            UIAction(title: i.int32Value < 0 ? "Sans sous-titres" : n, state: i.int32Value == scur ? .on : .off) { [weak self] _ in
                self?.mp.currentVideoSubTitleIndex = i.int32Value
                self?.rebuildTrackMenus()
            }
        }
        subsBtn.menu = UIMenu(title: "Sous-titres", children: subs)
        subsBtn.isHidden = subs.count < 2
    }

    private func rebuildSourceMenu() {
        let items = streams.enumerated().map { k, s in
            UIAction(title: (s["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Source \(k + 1)",
                     state: k == idx ? .on : .off) { [weak self] _ in
                guard let self = self else { return }
                self.retries = 0
                self.open(k, at: self.live ? 0 : max(0, self.lastPos - 2))
            }
        }
        srcBtn.menu = UIMenu(title: "Version", children: items)
        srcBtn.isHidden = streams.count < 2
    }

    private func showResolution() {
        let size = mp.videoSize
        guard size.width > 0, size.height > 0 else { return }
        let p = min(size.width * 9 / 16, size.height)
        let res = size.width >= 3200 || p >= 1800 ? "4K" : p >= 1000 ? "1080p" : p >= 700 ? "720p" : "\(Int(p))p"
        resBadge.text = res
        resBadge.isHidden = false
    }

    // MARK: - Affichage des commandes

    @objc private func toggleControls() {
        if controlsVisible { hideControls() } else { showControls() }
    }

    /// Les taps sont comptés pendant un court instant : 1 = commandes, 2 = ±10 s, 3 et plus = ±30 s.
    /// Côté gauche de l'écran : on recule ; côté droit : on avance.
    @objc private func tapped(_ g: UITapGestureRecognizer) {
        let pt = g.location(in: view)
        let canSeek = !live && length > 0 && msgBox.isHidden
        if tapCount > 0 && canSeek && (pt.x < view.bounds.midX) != (tapPoint.x < view.bounds.midX) { tapCount = 0 }
        tapCount += 1
        tapPoint = pt
        tapTimer?.invalidate()
        if tapCount >= 2 && canSeek { haptic.impactOccurred(); showSeekPreview() }
        tapTimer = Timer.scheduledTimer(withTimeInterval: tapCount >= 2 ? 0.42 : 0.28, repeats: false) { [weak self] _ in
            self?.resolveTaps(canSeek: canSeek)
        }
    }

    private func resolveTaps(canSeek: Bool) {
        let n = tapCount
        tapCount = 0
        if n <= 1 || !canSeek { toggleControls(); return }
        let forward = tapPoint.x >= view.bounds.midX
        seek((n >= 3 ? 30 : 10) * (forward ? 1 : -1))
        hideSeekBubble()
    }

    private func buildSeekBubble() {
        seekLabel.font = .systemFont(ofSize: 22, weight: .heavy)
        seekLabel.textColor = .white
        seekLabel.textAlignment = .center
        seekLabel.numberOfLines = 2
        seekLabel.frame = CGRect(x: 0, y: 0, width: 120, height: 120)
        seekBubble.contentView.addSubview(seekLabel)
        seekBubble.frame = CGRect(x: 0, y: 0, width: 120, height: 120)
        seekBubble.alpha = 0
        seekBubble.isUserInteractionEnabled = false
        view.insertSubview(seekBubble, aboveSubview: touchLayer)
    }

    private func showSeekPreview() {
        let forward = tapPoint.x >= view.bounds.midX
        let secs = tapCount >= 3 ? 30 : 10
        let arrow = UIImage(systemName: forward ? "goforward" : "gobackward")
        let txt = NSMutableAttributedString(attachment: NSTextAttachment(image: arrow!.withTintColor(.white)))
        txt.append(NSAttributedString(string: "\n\(forward ? "+" : "−")\(secs) s"))
        seekLabel.attributedText = txt
        let w = view.bounds.width
        seekBubble.center = CGPoint(x: forward ? w * 0.78 : w * 0.22, y: view.bounds.midY)
        seekBubble.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.8,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.seekBubble.alpha = 1
            self.seekBubble.transform = .identity
        }
    }

    private func hideSeekBubble() {
        UIView.animate(withDuration: 0.3, delay: 0.25, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.seekBubble.alpha = 0
            self.seekBubble.transform = CGAffineTransform(scaleX: 1.15, y: 1.15)
        }
    }

    private func showControls() {
        controlsVisible = true
        UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0.4,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.topBar.alpha = 1
            self.bottomBar.alpha = 1
            self.bottomBar.transform = .identity
        }
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self = self, self.mp.isPlaying, !self.scrubbing else { return }
            self.hideControls()
        }
    }

    private func hideControls() {
        controlsVisible = false
        UIView.animate(withDuration: 0.35, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.topBar.alpha = 0
            self.bottomBar.alpha = 0
            self.bottomBar.transform = CGAffineTransform(translationX: 0, y: 16)
        }
    }

    private func showMessage(_ text: String, retry: Bool = true) {
        msgLabel.text = text
        msgRetry.isHidden = !retry
        msgBox.isHidden = false
        if !retry {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self = self, self.msgLabel.text == text else { return }
                self.hideMessage()
            }
        }
    }

    private func hideMessage() { msgBox.isHidden = true }

    private func clock(_ s: Double) -> String {
        let t = Int(max(0, s))
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }

    private func endTime() -> String {
        guard length > 0 else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return " · fin à " + f.string(from: Date().addingTimeInterval(length - lastPos))
    }

    // MARK: - Construction de l'interface

    private func roundButton(_ b: UIButton, _ symbol: String, size: CGFloat, filled: Bool = false) {
        let cfg = UIImage.SymbolConfiguration(pointSize: size * 0.42, weight: .bold)
        b.setImage(UIImage(systemName: symbol, withConfiguration: cfg), for: .normal)
        b.setPreferredSymbolConfiguration(cfg, forImageIn: .normal)
        b.tintColor = filled ? UIColor(red: 22 / 255, green: 7 / 255, blue: 13 / 255, alpha: 1) : .white
        b.backgroundColor = filled ? .white : .clear
        b.layer.cornerRadius = size / 2
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: size).isActive = true
        b.heightAnchor.constraint(equalToConstant: size).isActive = true
    }

    private func chip(_ b: UIButton, _ symbol: String, _ title: String) {
        var c = UIButton.Configuration.plain()
        c.image = UIImage(systemName: symbol)
        c.imagePadding = 7
        c.title = title
        c.baseForegroundColor = .white
        c.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14)
        c.background.backgroundColor = UIColor.white.withAlphaComponent(0.12)
        c.background.cornerRadius = 14
        c.background.strokeColor = UIColor.white.withAlphaComponent(0.22)
        c.background.strokeWidth = 1
        b.configuration = c
        b.showsMenuAsPrimaryAction = true
    }

    private func buildUI() {
        // haut : fermer, titre, qualité
        let closeWrap = GlassView(radius: 26)
        closeWrap.translatesAutoresizingMaskIntoConstraints = false
        roundButton(closeBtn, "chevron.backward", size: 52)
        closeBtn.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        closeWrap.contentView.addSubview(closeBtn)
        NSLayoutConstraint.activate([
            closeBtn.centerXAnchor.constraint(equalTo: closeWrap.centerXAnchor),
            closeBtn.centerYAnchor.constraint(equalTo: closeWrap.centerYAnchor),
            closeWrap.widthAnchor.constraint(equalToConstant: 52), closeWrap.heightAnchor.constraint(equalToConstant: 52),
        ])
        titleLabel.font = .systemFont(ofSize: 22, weight: .heavy)
        titleLabel.textColor = .white
        subLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        subLabel.textColor = UIColor.white.withAlphaComponent(0.78)
        let titles = UIStackView(arrangedSubviews: [titleLabel, subLabel])
        titles.axis = .vertical
        titles.spacing = 1
        titles.translatesAutoresizingMaskIntoConstraints = false
        titleBox.contentView.addSubview(titles)
        NSLayoutConstraint.activate([
            titles.leadingAnchor.constraint(equalTo: titleBox.leadingAnchor, constant: 20),
            titles.trailingAnchor.constraint(equalTo: titleBox.trailingAnchor, constant: -20),
            titles.topAnchor.constraint(equalTo: titleBox.topAnchor, constant: 10),
            titles.bottomAnchor.constraint(equalTo: titleBox.bottomAnchor, constant: -10),
        ])
        resBadge.font = .systemFont(ofSize: 12, weight: .heavy)
        resBadge.textColor = .white
        resBadge.backgroundColor = accent.withAlphaComponent(0.9)
        resBadge.layer.cornerRadius = 8
        resBadge.clipsToBounds = true
        resBadge.isHidden = true
        topBar.addArrangedSubview(closeWrap)
        topBar.addArrangedSubview(titleBox)
        topBar.addArrangedSubview(resBadge)
        topBar.addArrangedSubview(UIView())
        topBar.axis = .horizontal
        topBar.alignment = .center
        topBar.spacing = 16
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        // bas : barre de commandes en verre
        roundButton(playBtn, "pause.fill", size: 56, filled: true)
        playBtn.addTarget(self, action: #selector(togglePlay), for: .touchUpInside)
        roundButton(backBtn, "gobackward.10", size: 46)
        backBtn.addTarget(self, action: #selector(back), for: .touchUpInside)
        roundButton(fwdBtn, "goforward.30", size: 46)
        fwdBtn.addTarget(self, action: #selector(fwd), for: .touchUpInside)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 16, weight: .bold)
        timeLabel.textColor = .white
        chip(audioBtn, "speaker.wave.2.fill", "Langue")
        chip(subsBtn, "captions.bubble", "Sous-titres")
        chip(srcBtn, "square.stack.3d.up", "Version")
        var nc = UIButton.Configuration.filled()
        nc.title = "Épisode suivant"
        nc.image = UIImage(systemName: "forward.end.fill")
        nc.imagePadding = 7
        nc.baseBackgroundColor = .white
        nc.baseForegroundColor = UIColor(red: 22 / 255, green: 7 / 255, blue: 13 / 255, alpha: 1)
        nc.cornerStyle = .capsule
        nextBtn.configuration = nc
        nextBtn.addTarget(self, action: #selector(goNext), for: .touchUpInside)
        slider.minimumTrackTintColor = accent
        slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.25)
        slider.thumbTintColor = .white
        slider.addTarget(self, action: #selector(sliderBegan), for: .touchDown)
        slider.addTarget(self, action: #selector(sliderMoved), for: .valueChanged)
        slider.addTarget(self, action: #selector(sliderEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        let row = UIStackView(arrangedSubviews: [playBtn, backBtn, fwdBtn, timeLabel, UIView(), audioBtn, subsBtn, srcBtn, nextBtn])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.setCustomSpacing(18, after: fwdBtn)
        let col = UIStackView(arrangedSubviews: [slider, row])
        col.axis = .vertical
        col.spacing = 12
        col.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.contentView.addSubview(col)
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottomBar)
        NSLayoutConstraint.activate([
            col.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 22),
            col.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -22),
            col.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 16),
            col.bottomAnchor.constraint(equalTo: bottomBar.bottomAnchor, constant: -14),
            bottomBar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 30),
            bottomBar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -30),
            bottomBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -22),
            topBar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 30),
            topBar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -30),
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 22),
        ])

        // carte « Épisode suivant »
        upLabel.numberOfLines = 3
        upLabel.font = .systemFont(ofSize: 15, weight: .bold)
        upLabel.textColor = .white
        upLabel.translatesAutoresizingMaskIntoConstraints = false
        upNext.contentView.addSubview(upLabel)
        upNext.translatesAutoresizingMaskIntoConstraints = false
        upNext.isHidden = true
        let upTap = UITapGestureRecognizer(target: self, action: #selector(goNext))
        upNext.addGestureRecognizer(upTap)
        view.addSubview(upNext)
        NSLayoutConstraint.activate([
            upLabel.leadingAnchor.constraint(equalTo: upNext.leadingAnchor, constant: 18),
            upLabel.trailingAnchor.constraint(equalTo: upNext.trailingAnchor, constant: -18),
            upLabel.topAnchor.constraint(equalTo: upNext.topAnchor, constant: 14),
            upLabel.bottomAnchor.constraint(equalTo: upNext.bottomAnchor, constant: -14),
            upNext.widthAnchor.constraint(equalToConstant: 300),
            upNext.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -30),
            upNext.bottomAnchor.constraint(equalTo: bottomBar.topAnchor, constant: -16),
        ])

        // message (coupure, erreur) et chargement
        msgLabel.numberOfLines = 0
        msgLabel.textAlignment = .center
        msgLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        msgLabel.textColor = .white
        var rc = UIButton.Configuration.filled()
        rc.title = "Réessayer"
        rc.baseBackgroundColor = .white
        rc.baseForegroundColor = .black
        rc.cornerStyle = .capsule
        msgRetry.configuration = rc
        msgRetry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        let msgStack = UIStackView(arrangedSubviews: [msgLabel, msgRetry])
        msgStack.axis = .vertical
        msgStack.spacing = 16
        msgStack.alignment = .center
        msgStack.translatesAutoresizingMaskIntoConstraints = false
        msgBox.contentView.addSubview(msgStack)
        msgBox.translatesAutoresizingMaskIntoConstraints = false
        msgBox.isHidden = true
        view.addSubview(msgBox)
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            msgStack.leadingAnchor.constraint(equalTo: msgBox.leadingAnchor, constant: 26),
            msgStack.trailingAnchor.constraint(equalTo: msgBox.trailingAnchor, constant: -26),
            msgStack.topAnchor.constraint(equalTo: msgBox.topAnchor, constant: 22),
            msgStack.bottomAnchor.constraint(equalTo: msgBox.bottomAnchor, constant: -22),
            msgBox.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            msgBox.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            msgBox.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }
}

/// Panneau « verre » : flou + reflet en haut + fin liseré clair.
final class GlassView: UIVisualEffectView {
    init(radius: CGFloat) {
        super.init(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        layer.borderWidth = 1
        layer.borderColor = UIColor.white.withAlphaComponent(0.22).cgColor
        let shine = CAGradientLayer()
        shine.colors = [UIColor.white.withAlphaComponent(0.18).cgColor, UIColor.white.withAlphaComponent(0).cgColor]
        shine.startPoint = CGPoint(x: 0.2, y: 0)
        shine.endPoint = CGPoint(x: 0.5, y: 0.7)
        contentView.layer.addSublayer(shine)
        self.shine = shine
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) non utilisé") }

    private var shine: CAGradientLayer?
    override func layoutSubviews() {
        super.layoutSubviews()
        shine?.frame = bounds
    }
}

/// Étiquette avec marges intérieures (badge de qualité).
final class PaddedLabel: UILabel {
    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: UIEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)))
    }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + 20, height: s.height + 8)
    }
}

/// Pile de vues qui laisse passer les touchers dans ses zones vides (barre du haut du lecteur).
final class PassThroughStack: UIStackView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let v = super.hitTest(point, with: event)
        return v === self || (v != nil && v!.subviews.isEmpty && !(v is UIControl) && !(v is UILabel) && v!.superview === self) ? nil : v
    }
}

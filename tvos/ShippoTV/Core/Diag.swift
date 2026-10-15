import Foundation

/// Journal de démarrage gardé dans la mémoire durable : si l'appli se ferme pendant le lancement,
/// le lancement suivant affiche les étapes atteintes (diagnostic sans Mac ni câble).
enum Diag {
    private static let d = UserDefaults.standard
    private static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f }()

    /// Journal du lancement précédent s'il ne s'est pas terminé normalement (sinon nil).
    private(set) static var previousCrash: [String]? = nil

    static func begin() {
        if d.bool(forKey: "diag.running") {
            previousCrash = d.stringArray(forKey: "diag.log") ?? []
        }
        d.set(true, forKey: "diag.running")
        d.set([String](), forKey: "diag.log")
        d.synchronize()
        NSSetUncaughtExceptionHandler { e in
            Diag.step("EXCEPTION \(e.name.rawValue) : \(e.reason ?? "")")
        }
        step("démarrage (tvOS \(ProcessInfo.processInfo.operatingSystemVersionString))")
    }

    static func step(_ s: String) {
        var log = d.stringArray(forKey: "diag.log") ?? []
        log.append(fmt.string(from: Date()) + "  " + s)
        if log.count > 60 { log.removeFirst(log.count - 60) }
        d.set(log, forKey: "diag.log")
        d.synchronize()
        NSLog("[diag] %@", s)
    }

    /// Lancement réussi : le prochain démarrage sera normal.
    static func finished() {
        step("lancement terminé")
        d.set(false, forKey: "diag.running")
        d.synchronize()
    }

    static func clearPrevious() {
        previousCrash = nil
    }
}

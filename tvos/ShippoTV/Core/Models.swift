import Foundation

/// Identifiant qui peut arriver en nombre (flux Xtream) ou en texte (épisodes) : gardé en texte.
struct FlexID: Codable, Hashable, CustomStringConvertible {
    let value: String
    init(_ v: String) { value = v }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { value = String(i) }
        else if let d = try? c.decode(Double.self) { value = d == d.rounded() ? String(Int(d)) : String(d) }
        else { value = (try? c.decode(String.self)) ?? "" }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let i = Int(value) { try c.encode(i) } else { try c.encode(value) }
    }
    var description: String { value }
    /// Valeur à renvoyer au moteur (nombre si possible, comme dans le catalogue).
    var json: Any { Int(value).map { $0 as Any } ?? value }
}

/// Liste de catégories : tableau pour les films et séries, texte seul pour les chaînes.
struct FlexList: Codable, Hashable {
    let items: [String]
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let a = try? c.decode([FlexID].self) { items = a.map(\.value) }
        else if let s = try? c.decode(FlexID.self) { items = [s.value] }
        else { items = [] }
    }
    func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(items) }
}

// MARK: - Catalogue

struct Version: Codable, Hashable {
    let id: FlexID
    let ext: String?
    let q: String?
    let rank: Int?
    let n: String?
}

struct Movie: Codable, Hashable, Identifiable {
    let k: String
    let t: String
    let y: Int?
    let p: String?
    let c: FlexList?
    let a: Double?
    let r: Double?
    let tm: FlexID?
    let v: [Version]
    var id: String { k }
}

struct SeriesSource: Codable, Hashable {
    let id: FlexID
    let q: String?
    let n: String?
}

struct Series: Codable, Hashable, Identifiable {
    let k: String
    let t: String
    let y: Int?
    let p: String?
    let bd: String?
    let c: FlexList?
    let a: Double?
    let r: Double?
    let tm: FlexID?
    let pl: String?
    let g: String?
    let s: [SeriesSource]
    var id: String { k }
}

struct LiveSource: Codable, Hashable {
    let id: FlexID
    let q: String?
    let n: String?
}

struct Channel: Codable, Hashable, Identifiable {
    let k: String
    let t: String
    let p: String?
    let c: FlexList?
    let s: [LiveSource]
    let num: Int?
    let loc: Int?
    var id: String { k }
}

// MARK: - Séries (saisons et épisodes, chargés à l'ouverture de la fiche)

struct Episode: Codable, Hashable, Identifiable {
    let id: FlexID
    let n: Int
    let t: String
    let ext: String?
    let img: String?
    let plot: String?
    let dur: String?
}

struct SeriesExtra: Codable, Hashable {
    let plot: String?
    let cast: String?
    let genre: String?
    let director: String?
    let rating: FlexID?
    let backdrop: String?
}

struct SeriesInfo: Codable {
    let seasons: [String]
    let episodes: [String: [Episode]]
    let info: SeriesExtra?
}

/// Épisode tel qu'enregistré dans la progression (synchronisée avec les autres appareils).
struct EpisodeRef: Codable, Hashable {
    let id: FlexID?
    let ext: String?
    let sid: FlexID?
}

/// « À suivre » : prochain épisode d'une série regardée (calculé par le moteur, comme sur PC et télé).
struct UpNext: Codable, Hashable, Identifiable {
    let key: String
    let label: String?
    let sub: String?
    let pid: String
    let ep: EpisodeRef
    let img: String?
    let pos: Double?
    let dur: Double?
    let next: Bool?
    let ts: Double?
    var id: String { pid }
}

// MARK: - Direct

struct NowProg: Codable, Hashable {
    let t: String?
    let s: Double?
    let e: Double?
}

struct LiveNow: Codable {
    let now: [String: NowProg]?
}

struct Reminder: Codable, Hashable {
    let key: String
    let ch: String?
    let title: String?
    let start: Double
    let end: Double?
}

/// Lectures en cours sur les autres appareils du groupe (abonnement limité en nombre d'écrans).
struct OtherDevice: Codable, Hashable, Identifiable {
    let id: String
    let name: String?
    let title: String?
}

struct Others: Codable {
    let others: [OtherDevice]
    let max: Int?
}

struct GuideProg: Codable, Hashable {
    let title: String
    let desc: String?
    let start: Double
    let end: Double
    let tag: String?
}

struct GuideRow: Codable, Hashable, Identifiable {
    let key: String
    let ch: String
    let logo: String?
    let progs: [GuideProg]
    var id: String { key }
}

struct GuideData: Codable {
    let t0: Double
    let t1: Double
    let rows: [GuideRow]
}

struct EpgItem: Codable, Hashable {
    let title: String
    let desc: String?
    let start: Double
    let end: Double
}

struct CatOrder: Codable, Hashable {
    let movies: [String]?
    let series: [String]?
    let live: [String]?
}

struct Cats: Codable, Hashable {
    let movies: [String: String]?
    let series: [String: String]?
    let live: [String: String]?
    let order: CatOrder?
}

/// Fiche TMDB allégée (affiche, image de fond, note, résumé si complète).
struct Meta: Codable, Hashable {
    let id: Int?
    let t: String?
    let y: Int?
    let p: String?
    let b: String?
    let v: Double?
    let o: String?
    let g: [String]?
    let rt: Int?
}

struct Account: Codable, Hashable {
    let exp: Double?
    let max: FlexID?
}

struct Catalog: Codable {
    let movies: [Movie]
    let series: [Series]
    let live: [Channel]
    let cats: Cats?
    let meta: [String: Meta]?
    let account: Account?
}

// MARK: - Réglages

struct Profile: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let color: String?
    let kids: Bool?
}

struct WatchProgress: Codable, Hashable {
    let kind: String?
    let key: String?
    let label: String?
    let ep: EpisodeRef?
    let pos: Double?
    let dur: Double?
    let vid: FlexID?
    let done: Bool?
    let ts: Double?
}

struct Config: Codable {
    let configured: Bool
    let server: String?
    let username: String?
    let version: String?
    let profiles: [Profile]
    let profile: String?
    let favs: [String]?
    let progress: [String: WatchProgress]?
    let reminders: [Reminder]?
    let phone_setup: Bool?
    let has_tmdb: Bool?
    let refreshing: Bool?
    let catalog_ts: Double?
}

// MARK: - Réponses diverses

struct DiscoverRow: Codable, Hashable {
    let id: String?
    let title: String
    let kind: String?
    let keys: [String]?
}

struct Discover: Codable {
    let rows: [DiscoverRow]
    let no_key: Bool?
}

struct MovieInfo: Codable {
    let plot: String?
    let cast: String?
    let director: String?
    let genre: String?
    let duration: String?
    let backdrop: String?
}

struct StreamInfo: Codable {
    let url: String
    let ext: String?
    let live: Bool?
}

struct PairCode: Codable {
    let code: String
    let expires: Double?
}

struct SyncStatus: Codable {
    let configured: Bool?
    let in_group: Bool?
    let group_name: String?
    let error: String?
    let pair: PairCode?
    let creds: Bool?
}

struct PhoneStart: Codable {
    let url: String?
    let exp: Double?
    let error: String?
}

struct PhoneState: Codable {
    let state: String?
    let tried: Bool?
    let error: String?
}

// MARK: - Images TMDB

enum TMDBImage {
    /// Essais GitHub : images servies par le faux TMDB local (img_base), sinon le vrai TMDB.
    static let base = TestConfig.load()?.imgBase ?? "https://image.tmdb.org/t/p/"
    static func url(_ path: String?, size: String) -> URL? {
        guard let p = path, !p.isEmpty else { return nil }
        if p.hasPrefix("http") { return URL(string: p) }
        return URL(string: base + size + p)
    }
}

import Foundation

// Whether to ask for a rating with Apple's own prompt (App.swift shows it), nothing before it. The page reports each
// cast or reply the person posted; the prompt may come once 5 went out, the app was used on 3 different days and first
// opened 3 or more days ago. iOS never says whether they rated, so it's asked at most twice: the second time 120 days
// later, in a newer build. Same rule in Android's RatingPrompt.java. Foundation only, so ios/Tests can run it on a Mac.
enum RatingPrompt {
    static let casts = 5, days = 3
    static let day: TimeInterval = 86400, again = 120 * day

    static func due(now: Date, first: Date, days: Int, casts: Int, asks: Int, last: Date, lastVersion: Int, version: Int) -> Bool {
        casts >= Self.casts && days >= Self.days && now.timeIntervalSince(first) >= Double(Self.days) * day
            && (asks == 0 || asks == 1 && now.timeIntervalSince(last) >= again && version > lastVersion)
    }

    static let store = UserDefaults.standard

    // the app came to the front: one more day it was used on
    static func used() {
        let today = Calendar.current.ordinality(of: .day, in: .era, for: Date()) ?? 0
        guard store.integer(forKey: "rating.day") != today else { return }
        store.set(today, forKey: "rating.day")
        store.set(store.integer(forKey: "rating.days") + 1, forKey: "rating.days")
        if store.object(forKey: "rating.first") == nil { store.set(Date(), forKey: "rating.first") }
    }

    // a cast or reply went out and the composer closed: true when that's the moment to ask, which then counts as asked
    static func cast() -> Bool {
        let now = Date(), casts = store.integer(forKey: "rating.casts") + 1, asks = store.integer(forKey: "rating.asks")
        let version = Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0
        store.set(casts, forKey: "rating.casts")
        guard due(now: now, first: store.object(forKey: "rating.first") as? Date ?? now, days: store.integer(forKey: "rating.days"), casts: casts,
                  asks: asks, last: store.object(forKey: "rating.last") as? Date ?? now, lastVersion: store.integer(forKey: "rating.version"), version: version)
        else { return false }
        store.set(asks + 1, forKey: "rating.asks")
        store.set(now, forKey: "rating.last")
        store.set(version, forKey: "rating.version")
        return true
    }
}

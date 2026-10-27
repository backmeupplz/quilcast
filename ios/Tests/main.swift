// RatingPrompt's rule, run on the Mac: swiftc ios/Quilcast/RatingPrompt.swift ios/Tests/main.swift -o rating && ./rating
import Foundation

let now = Date(), day = RatingPrompt.day
func due(first: Double, days: Int, casts: Int, asks: Int = 0, last: Double = 0, lastVersion: Int = 0, version: Int = 1) -> Bool {
    RatingPrompt.due(now: now, first: now - first * day, days: days, casts: casts, asks: asks, last: now - last * day, lastVersion: lastVersion, version: version)
}

precondition(due(first: 3, days: 3, casts: 5))
precondition(!due(first: 3, days: 3, casts: 4), "4 casts")
precondition(!due(first: 30, days: 2, casts: 50), "2 days used")
precondition(!due(first: 2, days: 3, casts: 5), "first use 2 days ago")
// the second time: 120 days on and a newer version
precondition(due(first: 300, days: 30, casts: 50, asks: 1, last: 120, lastVersion: 1, version: 2))
precondition(!due(first: 300, days: 30, casts: 50, asks: 1, last: 119, lastVersion: 1, version: 2), "119 days")
precondition(!due(first: 300, days: 30, casts: 50, asks: 1, last: 200, lastVersion: 2, version: 2), "same version")
precondition(!due(first: 600, days: 30, casts: 50, asks: 2, last: 200, lastVersion: 1, version: 3), "asked twice")
print("RatingPrompt: ok")

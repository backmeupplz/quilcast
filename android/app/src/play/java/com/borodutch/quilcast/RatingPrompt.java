package com.borodutch.quilcast;

import android.app.Activity;
import android.content.SharedPreferences;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import java.time.LocalDate;

/**
 * Asks for a rating with Google's own review card, nothing before it. The page reports each cast or reply the person
 * posted; the card may come once 5 went out, the app was used on 3 different days and first opened 3 or more days ago.
 * Play never says whether they rated, so it's asked at most twice: the second time 120 days later, in a newer version.
 * Same rule in iOS's RatingPrompt.swift; the F-Droid build's RatingPrompt does nothing.
 */
final class RatingPrompt {
    static final int CASTS = 5, DAYS = 3;
    static final long DAY = 86_400_000L, AGAIN = 120 * DAY;

    static boolean due(long now, long first, int days, int casts, int asks, long last, int lastVersion, int version) {
        return casts >= CASTS && days >= DAYS && now - first >= DAYS * DAY
            && (asks == 0 || asks == 1 && now - last >= AGAIN && version > lastVersion);
    }

    static SharedPreferences prefs(Activity a) {
        return a.getSharedPreferences("rating", Activity.MODE_PRIVATE);
    }

    // the app came to the front: one more day it was used on
    static void used(Activity a) {
        SharedPreferences p = prefs(a);
        long today = LocalDate.now().toEpochDay();
        if (p.getLong("day", -1) == today) return;
        p.edit().putLong("day", today).putInt("days", p.getInt("days", 0) + 1)
            .putLong("first", p.getLong("first", System.currentTimeMillis())).apply();
    }

    // a cast or reply went out and the composer closed
    static void cast(Activity a) {
        SharedPreferences p = prefs(a);
        long now = System.currentTimeMillis();
        int casts = p.getInt("casts", 0) + 1, asks = p.getInt("asks", 0);
        p.edit().putInt("casts", casts).apply();
        if (!due(now, p.getLong("first", now), p.getInt("days", 0), casts, asks, p.getLong("last", 0), p.getInt("version", 0), BuildConfig.VERSION_CODE)) return;
        p.edit().putInt("asks", asks + 1).putLong("last", now).putInt("version", BuildConfig.VERSION_CODE).apply();
        ReviewManager m = ReviewManagerFactory.create(a);
        m.requestReviewFlow().addOnCompleteListener(t -> {
            if (t.isSuccessful()) m.launchReviewFlow(a, t.getResult());
        });
    }
}

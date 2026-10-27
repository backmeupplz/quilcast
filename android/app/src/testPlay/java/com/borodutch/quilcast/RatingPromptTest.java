package com.borodutch.quilcast;

import static com.borodutch.quilcast.RatingPrompt.DAY;
import static com.borodutch.quilcast.RatingPrompt.due;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RatingPromptTest {
    static final long NOW = 1_000 * DAY;

    @Test
    public void rule() {
        assertTrue(due(NOW, NOW - 3 * DAY, 3, 5, 0, 0, 0, 1));
        assertFalse("4 casts", due(NOW, NOW - 3 * DAY, 3, 4, 0, 0, 0, 1));
        assertFalse("2 days used", due(NOW, NOW - 30 * DAY, 2, 50, 0, 0, 0, 1));
        assertFalse("first use 2 days ago", due(NOW, NOW - 2 * DAY, 3, 5, 0, 0, 0, 1));
        // the second time: 120 days on and a newer version
        assertTrue(due(NOW, NOW - 300 * DAY, 30, 50, 1, NOW - 120 * DAY, 1, 2));
        assertFalse("119 days", due(NOW, NOW - 300 * DAY, 30, 50, 1, NOW - 119 * DAY, 1, 2));
        assertFalse("same version", due(NOW, NOW - 300 * DAY, 30, 50, 1, NOW - 200 * DAY, 2, 2));
        assertFalse("asked twice", due(NOW, NOW - 600 * DAY, 30, 50, 2, NOW - 200 * DAY, 1, 3));
    }
}

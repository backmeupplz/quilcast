package com.borodutch.quilcast;

import static com.borodutch.quilcast.Files.type;
import static com.borodutch.quilcast.Files.types;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class FilesTest {
    static final String[] MEDIA = {"image/*", "video/mp4", "video/webm", "video/quicktime"};

    @Test
    public void composerInputs() {
        // "Add photo or video", split by WebView or handed over as one string
        assertArrayEquals(MEDIA, types(new String[] {"image/*", "video/mp4", "video/webm", "video/quicktime"}));
        assertArrayEquals(MEDIA, types(new String[] {"image/*,video/mp4,video/webm,video/quicktime"}));
        assertArrayEquals(MEDIA, types(new String[] {" Image/* , video/mp4,,video/webm, video/quicktime,video/mp4 "}));
        assertEquals("*/*", type(MEDIA));
        // the Markdown picture button
        assertArrayEquals(new String[] {"image/*"}, types(new String[] {"image/*"}));
        assertEquals("image/*", type(types(new String[] {"image/*"})));
    }

    @Test
    public void sameFamily() {
        assertEquals("image/*", type(types(new String[] {"image/png,image/jpeg"})));
        assertEquals("video/*", type(types(new String[] {"video/mp4", "video/webm"})));
    }

    @Test
    public void anything() {
        assertArrayEquals(new String[0], types(null));
        assertArrayEquals(new String[0], types(new String[] {""}));
        assertArrayEquals(new String[0], types(new String[] {null}));
        assertEquals("*/*", type(types(new String[] {""})));
        // an extension or */* lifts the filter instead of narrowing it to the rest
        assertArrayEquals(new String[0], types(new String[] {"image/png,.heic"}));
        assertArrayEquals(new String[0], types(new String[] {"*/*", "image/png"}));
        assertArrayEquals(new String[0], types(new String[] {"image"}));
    }
}

package com.borodutch.quilcast;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The page's file inputs (the composer's "Add photo or video" and Markdown picture buttons). WebView's own
 * FileChooserParams.createIntent() asks for one file of the first accepted type, and parseResult() reads only
 * getData(): pickers that return the selection in ClipData (the photo picker, Google Photos, any multi-select) came
 * back as nothing, so the picked images were never attached.
 */
final class Files {
    private Files() {
    }

    static Intent intent(String[] accept, boolean multiple) {
        String[] types = types(accept);
        Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type(types));
        if (types.length > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, types);
        if (multiple) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        return i;
    }

    /**
     * Everything picked: the ClipData items and getData(), once each; null when nothing was (the page sees a cancel).
     * Only content:// URIs: a picker app answering with file:// could otherwise hand the page the app's own files
     * (the WebView's storage, where the site keeps its keys), and the composer uploads what it gets. A single-file
     * input gets only the first one, even from a picker that ignores the missing EXTRA_ALLOW_MULTIPLE.
     */
    static Uri[] picked(int result, Intent data, boolean multiple) {
        if (result != Activity.RESULT_OK || data == null) return null;
        Set<Uri> uris = new LinkedHashSet<>();
        ClipData clip = data.getClipData();
        if (clip != null) for (int n = 0; n < clip.getItemCount(); n++) uris.add(clip.getItemAt(n).getUri());
        uris.add(data.getData());
        uris.removeIf(u -> u == null || !"content".equals(u.getScheme()));
        if (uris.isEmpty()) return null;
        return multiple ? uris.toArray(new Uri[0]) : new Uri[] {uris.iterator().next()};
    }

    /**
     * The accept attribute's MIME types. WebView hands it over split on commas or as one comma-joined string, so both
     * are split here. An extension (".png") or anything else that isn't a MIME type makes it no list at all: the picker
     * then shows every file, as the page doesn't depend on the filter.
     */
    static String[] types(String[] accept) {
        Set<String> types = new LinkedHashSet<>();
        if (accept != null) for (String a : accept) if (a != null) for (String t : a.split(",")) {
            t = t.trim().toLowerCase(Locale.ROOT);
            if (t.isEmpty()) continue;
            if (!t.matches("[a-z0-9][a-z0-9!#$&^_.+-]*/([a-z0-9][a-z0-9!#$&^_.+-]*|\\*)")) return new String[0];
            types.add(t);
        }
        return types.toArray(new String[0]);
    }

    /** The intent's own type: the only one, the shared family ("image/*") or anything */
    static String type(String[] types) {
        if (types.length == 0) return "*/*";
        if (types.length == 1) return types[0];
        String family = types[0].substring(0, types[0].indexOf('/') + 1);
        for (String t : types) if (!t.startsWith(family)) return "*/*";
        return family + "*";
    }
}

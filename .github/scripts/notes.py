# Shared release script: keep .github/scripts/ identical in absplus, meshtastic-plus, todorant and quilcast. Repo values come from env.
"""Release notes per language, in fastlane's layout that F-Droid reads too: the release scripts get the English
fastlane/metadata/android/en-US/changelogs/<versionCode>.txt, and a language's own notes sit next to it in
fastlane/metadata/android/<language>/changelogs/<versionCode>.txt (Play's language codes). A language without
its own notes gets the English ones."""
import os

# App Store locales whose folder has another name (Play's code); the rest are named alike
PLAY = {"es-MX": "es-419", "it": "it-IT", "ru": "ru-RU", "pl": "pl-PL", "tr": "tr-TR", "ja": "ja-JP", "ko": "ko-KR",
        "zh-Hans": "zh-CN", "zh-Hant": "zh-TW", "ar-SA": "ar", "hi": "hi-IN", "sv": "sv-SE", "da": "da-DK", "fi": "fi-FI",
        "no": "no-NO", "cs": "cs-CZ", "el": "el-GR", "he": "iw-IL", "hu": "hu-HU"}


def path(notes_file, language):
    """The language's notes file when it has one, else the English notes_file"""
    changelogs, name = os.path.split(os.path.normpath(notes_file))
    own = os.path.join(os.path.dirname(os.path.dirname(changelogs)), PLAY.get(language, language), os.path.basename(changelogs), name)
    return own if os.path.isfile(own) and open(own).read().strip() else notes_file


def read(notes_file, language, limit):
    return open(path(notes_file, language)).read().strip()[:limit]

# The store frames shared by raw.py and compose.py: each target's final size, the app's CSS width on that device, and
# where the caption and the screenshot go.
TARGETS = {
    'ios': (1320, 2868, 440),  # iPhone 6.9"
    'duo-outer': (1398, 2034, 466),  # iPhone Duo cover display
    'duo-inner': (2007, 2853, 669),  # iPhone Duo inner display
    'phone': (1080, 2160, 360),  # Play phone
    'tab7': (1200, 1920, 600),  # Play 7" tablet
    'tab10': (1600, 2560, 800),  # Play 10" tablet
}
GAP = 48  # caption to screenshot


def frame(target):
    W, H, css = TARGETS[target]
    m = round(W * 0.06)
    cap = round(H * 0.15)  # caption area: from the top edge to here
    iw = W - 2 * m
    ih = H - cap - GAP - m
    css_h = round(css * ih / iw)
    scale = iw / css
    ih = round(css_h * scale)  # the shot's real height after rounding the viewport
    return dict(W=W, H=H, css=css, css_h=css_h, scale=scale, m=m, cap=cap, iw=iw, ih=ih, top=H - m - ih)


# App Store locale -> (UI language, Google Play code)
LOCALES = {
    'en-US': ('en', 'en-US'), 'en-GB': ('en', 'en-GB'), 'de-DE': ('de', 'de-DE'), 'fr-FR': ('fr', 'fr-FR'), 'es-ES': ('es', 'es-ES'),
    'es-MX': ('es', 'es-419'), 'pt-BR': ('pt-BR', 'pt-BR'), 'pt-PT': ('pt-PT', 'pt-PT'), 'it': ('it', 'it-IT'), 'nl-NL': ('nl', 'nl-NL'),
    'ru': ('ru', 'ru-RU'), 'uk': ('uk', 'uk'), 'pl': ('pl', 'pl-PL'), 'tr': ('tr', 'tr-TR'), 'sv': ('sv', 'sv-SE'), 'ar-SA': ('ar', 'ar'),
    'ja': ('ja', 'ja-JP'), 'ko': ('ko', 'ko-KR'), 'zh-Hans': ('zh-Hans', 'zh-CN'), 'zh-Hant': ('zh-Hant', 'zh-TW'), 'hi': ('hi', 'hi-IN'),
    'id': ('id', 'id'), 'vi': ('vi', 'vi'), 'th': ('th', 'th'),
}
LANGUAGES = sorted({ui for ui, _ in LOCALES.values()})

if __name__ == '__main__':
    for t in TARGETS:
        print(t, frame(t))

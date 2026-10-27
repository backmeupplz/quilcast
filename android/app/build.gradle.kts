import java.util.Properties

plugins { id("com.android.application") }

// Upload key lives outside git: keystore.properties + the .jks it points to
val keys = Properties().apply { rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }

android {
    namespace = "com.borodutch.quilcast"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.borodutch.quilcast"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }
    // Without the key (e.g. on F-Droid's build server) release builds come out unsigned.
    signingConfigs {
        if (keys.isNotEmpty()) create("upload") {
            storeFile = rootProject.file(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
        }
    }
    buildFeatures { buildConfig = true }
    // play: Google's in-app review card. fdroid: no Google code, so F-Droid builds it (gradle: fdroid) and gets the
    // same APK as the release's quilcast-X.Y.Z.apk. See src/<flavor>/java/com/borodutch/quilcast/RatingPrompt.java.
    flavorDimensions += "store"
    productFlavors {
        create("play") { dimension = "store" }
        create("fdroid") { dimension = "store" }
    }
    // F-Droid rejects APKs carrying Google's encrypted dependency block. Play still gets it from the bundle.
    dependenciesInfo { includeInApk = false }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("upload")
        }
    }
}

dependencies {
    "playImplementation"("com.google.android.play:review:2.0.2")
    testImplementation("junit:junit:4.13.2")
}

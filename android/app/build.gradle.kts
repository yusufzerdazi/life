import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Personal tokens, compiled in (see secrets.properties.example). Gitignored.
val secrets = Properties().apply {
    val f = rootProject.file("secrets.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(key: String) = "\"" + (secrets.getProperty(key) ?: "").replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val webDir = rootProject.file("../web")

android {
    namespace = "com.zerdazi.life"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.zerdazi.life"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        for (key in listOf("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DATA_SOURCES")) {
            buildConfigField("String", key, secret(key))
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // The React UI (web/dist) ships inside the APK and is served from assets/web.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))

    buildTypes {
        // Personal sideload only: the release build is signed with the debug key
        // so `assembleRelease` gives an installable APK without a keystore.
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Reads Waking Up's meditation sessions (mindfulness records).
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}

val buildWeb by tasks.registering(Exec::class) {
    workingDir = webDir
    commandLine("sh", "-c", "npm install --no-save --no-audit --no-fund --loglevel=error && npm run build")
    inputs.dir(webDir.resolve("src"))
    inputs.dir(webDir.resolve("public"))
    inputs.file(webDir.resolve("index.html"))
    inputs.file(webDir.resolve("package-lock.json"))
    outputs.dir(webDir.resolve("dist"))
}

val copyWeb by tasks.registering(Sync::class) {
    dependsOn(buildWeb)
    from(webDir.resolve("dist"))
    into(layout.buildDirectory.dir("generated/webAssets/web"))
}

tasks.named("preBuild") { dependsOn(copyWeb) }

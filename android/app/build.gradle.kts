plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version : version.txt du dépôt + numéro de fabrication GitHub (les mises à jour comparent versionCode)
val shippoVersion = rootProject.file("../version.txt").readText().trim()
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "app.shippotv.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.shippotv.android"
        minSdk = 23
        targetSdk = 34
        versionCode = 1000 + buildNumber
        versionName = "$shippoVersion ($buildNumber)"
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64") }
    }

    signingConfigs {
        create("shippo") {
            val ks = rootProject.file("shippotv.jks")
            if (ks.exists()) {
                storeFile = ks
                storePassword = System.getenv("KS_PASS")
                keyAlias = "shippotv"
                keyPassword = System.getenv("KS_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (rootProject.file("shippotv.jks").exists()) signingConfigs.getByName("shippo") else signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    val media3 = "1.8.0"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("org.videolan.android:libvlc-all:3.6.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")
}

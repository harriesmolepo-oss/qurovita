# Building release APKs on Windows

This project's `android/` folder is committed to the repo as source of
truth. On Windows hosts, two extra pieces are required for release builds
because the Hermes compiler ships no native Windows binary
(facebook/react-native#55538):

1. **WSL must be installed** with a Linux distribution.
   Verify with: `wsl --status`

2. **The `hermesc.cmd` wrapper** in this directory invokes the Linux
   hermesc binary via WSL. It is referenced from `app/build.gradle`
   inside an `if (...isWindows())` guard, so it is a no-op on macOS,
   Linux, and EAS Build.

## Known fix patches in this folder

- `app/build.gradle` — Windows-only `hermesCommand` override.
- `app/src/main/java/co/qurovita/app/MainApplication.kt` —
  `reactNativeHost` abstract override. Present because of a mismatch
  between `expo-modules-core@55.x` (which only overrides `reactHost`)
  and `react-native@0.81.x` (which requires `reactNativeHost` as a
  non-nullable abstract member). TODO: remove once Expo/RN versions
  realign.
- `hermesc.cmd` — WSL wrapper, Windows-only.

## Building

  $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
  $env:ANDROID_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk"
  $env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
  cd apps\mobile\android
  .\gradlew.bat assembleRelease

APK output: `app\build\outputs\apk\release\app-release.apk`

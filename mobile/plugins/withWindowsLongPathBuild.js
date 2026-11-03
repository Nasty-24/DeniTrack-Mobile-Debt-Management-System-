/**
 * Expo config plugin: lets the Android native build work on Windows.
 *
 * React Native's CMake build nests absolute source paths inside the build directory, which
 * exceeds Windows' 260-character limit. Windows "long paths" (LongPathsEnabled=1) fixes this
 * only for long-path-aware tools, and the ninja bundled with the SDK's default CMake 3.22.1
 * (and 3.30.5) is 1.10.2, which is not. CMake 4.1.2 from the Android SDK bundles ninja 1.12.1,
 * which is. So on Windows hosts every native module is built with CMake 4.1.2, with
 * CMAKE_POLICY_VERSION_MINIMUM=3.5 so modules that still declare an older minimum configure.
 *
 * Requirements on Windows: LongPathsEnabled=1, and the SDK package cmake 4.1.2
 * (Android Studio SDK Manager, or `android sdk install cmake/4.1.2`). Other hosts are untouched.
 */
const { withSettingsGradle } = require('expo/config-plugins');

const MARKER = '// denitrack: windows-long-path-build';
const BLOCK = `
${MARKER}
if (System.getProperty('os.name').toLowerCase().contains('windows')) {
  // Set before any project is evaluated, because AGP locks the value once it has been read.
  gradle.beforeProject { p ->
    ['com.android.application', 'com.android.library'].each { id ->
      p.plugins.withId(id) {
        p.android.externalNativeBuild.cmake.version = '4.1.2'
        p.android.defaultConfig.externalNativeBuild.cmake.arguments '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'
      }
    }
  }
}
`;

module.exports = function withWindowsLongPathBuild(config) {
  return withSettingsGradle(config, (cfg) => {
    if (cfg.modResults.language === 'groovy' && !cfg.modResults.contents.includes(MARKER)) {
      cfg.modResults.contents += BLOCK;
    }
    return cfg;
  });
};

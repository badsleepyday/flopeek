"use strict";

const NATIVE_PLATFORM_TARGETS = Object.freeze([
  Object.freeze({ platform: "win32", arch: "x64", packageName: "@flopeek/native-win32-x64" }),
  Object.freeze({ platform: "win32", arch: "arm64", packageName: "@flopeek/native-win32-arm64" }),
  Object.freeze({ platform: "darwin", arch: "x64", packageName: "@flopeek/native-darwin-x64" }),
  Object.freeze({ platform: "darwin", arch: "arm64", packageName: "@flopeek/native-darwin-arm64" }),
  Object.freeze({ platform: "linux", arch: "x64", packageName: "@flopeek/native-linux-x64-gnu" }),
  Object.freeze({ platform: "linux", arch: "arm64", packageName: "@flopeek/native-linux-arm64-gnu" }),
]);

function nativePlatformPackageName(platform = process.platform, arch = process.arch) {
  return NATIVE_PLATFORM_TARGETS.find((target) => target.platform === platform && target.arch === arch)?.packageName || null;
}

function nativePlatformPackageNames() {
  return NATIVE_PLATFORM_TARGETS.map((target) => target.packageName);
}

module.exports = { NATIVE_PLATFORM_TARGETS, nativePlatformPackageName, nativePlatformPackageNames };

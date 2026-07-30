"use strict";

const NATIVE_PLATFORM_TARGETS = Object.freeze([
  Object.freeze({ platform: "win32", arch: "x64", packageName: "@flopeek/native-win32-x64", rustTarget: "x86_64-pc-windows-msvc" }),
  Object.freeze({ platform: "win32", arch: "arm64", packageName: "@flopeek/native-win32-arm64", rustTarget: "aarch64-pc-windows-msvc" }),
  Object.freeze({ platform: "darwin", arch: "x64", packageName: "@flopeek/native-darwin-x64", rustTarget: "x86_64-apple-darwin" }),
  Object.freeze({ platform: "darwin", arch: "arm64", packageName: "@flopeek/native-darwin-arm64", rustTarget: "aarch64-apple-darwin" }),
  Object.freeze({ platform: "linux", arch: "x64", packageName: "@flopeek/native-linux-x64-gnu", rustTarget: "x86_64-unknown-linux-gnu" }),
  Object.freeze({ platform: "linux", arch: "arm64", packageName: "@flopeek/native-linux-arm64-gnu", rustTarget: "aarch64-unknown-linux-gnu" }),
]);

function nativePlatformTarget(platform = process.platform, arch = process.arch) {
  return NATIVE_PLATFORM_TARGETS.find((target) => target.platform === platform && target.arch === arch) || null;
}

function nativePlatformPackageName(platform = process.platform, arch = process.arch) {
  return nativePlatformTarget(platform, arch)?.packageName || null;
}

function nativePlatformPackageNames() {
  return NATIVE_PLATFORM_TARGETS.map((target) => target.packageName);
}

module.exports = { NATIVE_PLATFORM_TARGETS, nativePlatformPackageName, nativePlatformPackageNames, nativePlatformTarget };

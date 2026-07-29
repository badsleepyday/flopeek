#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { verifyCleanRoomNativePlatformPackage } = require("../src/clean-room-package");

const tarballIndex = process.argv.indexOf("--platform-tarball");
const platformTarball = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : null;
if (tarballIndex >= 0 && !platformTarball) throw new Error("--platform-tarball requires a path.");

verifyCleanRoomNativePlatformPackage(path.resolve(__dirname, ".."), { platformTarball })
  .then((report) => {
    console.log(`Clean-room native platform verification: ${report.status}`);
    console.log(`${report.nativePlatform.packageName} resolved ${report.nativePlatform.resolvedBinary}`);
    console.log(`Native scan: ${report.nativePlatform.nativeScan.nodes} nodes; cache ${report.nativePlatform.nativeScan.cacheStatus}.`);
  })
  .catch((error) => {
    console.error(`Clean-room native platform verification failed: ${error.message}`);
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    process.exitCode = 1;
  });

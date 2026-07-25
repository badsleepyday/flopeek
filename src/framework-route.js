"use strict";

const path = require("node:path");

function removeExtension(filePath) {
  const extension = path.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function pathParts(relativePath) {
  return String(relativePath).split(path.sep).join("/").split("/");
}

function routeSegment(segment) {
  if (segment.startsWith("[...") && segment.endsWith("]")) return `*${segment.slice(4, -1)}`;
  if (segment.startsWith("[") && segment.endsWith("]")) return `:${segment.slice(1, -1)}`;
  return segment;
}

function svelteRoute(relativePath) {
  const parts = pathParts(relativePath);
  const routesIndex = parts.indexOf("routes");
  const filename = parts.at(-1) || "";
  if (routesIndex < 1 || parts[routesIndex - 1] !== "src" || !filename.startsWith("+")) return null;
  const filenameStem = removeExtension(filename);
  const kind = filenameStem.split(".")[0].slice(1);
  if (!["page", "layout", "server"].includes(kind)) return null;
  const segments = parts.slice(routesIndex + 1, -1).filter((segment) => !(segment.startsWith("(") && segment.endsWith(")"))).map(routeSegment);
  return { kind, route: segments.length ? `/${segments.join("/")}` : "/", handler: kind === "server", framework: "sveltekit" };
}

function nextRoute(relativePath) {
  const parts = pathParts(relativePath);
  const appIndex = parts.findIndex((part, index) => part === "app" && (index === 0 || parts[index - 1] === "src"));
  const filename = parts.at(-1) || "";
  if (appIndex < 0 || removeExtension(filename) !== "route") return null;
  const segments = parts.slice(appIndex + 1, -1).filter((segment) => !(segment.startsWith("(") && segment.endsWith(")"))).map(routeSegment);
  return { kind: "route", route: segments.length ? `/${segments.join("/")}` : "/", handler: true, framework: "next" };
}

function frameworkRoute(relativePath) {
  return svelteRoute(relativePath) || nextRoute(relativePath);
}

module.exports = { frameworkRoute, nextRoute, svelteRoute };

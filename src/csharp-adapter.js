const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let helperPath = null;
let attempted = false;

function helperTimeout(defaultTimeout) {
  const value = Number(process.env.FLOPEEK_TEST_MODE === "1" ? process.env.FLOPEEK_TEST_HELPER_TIMEOUT_MS : null);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultTimeout;
}

function dotnetRoot() {
  if (process.env.DOTNET_ROOT) return process.env.DOTNET_ROOT;
  if (process.platform === "win32") return "C:\\Program Files\\dotnet";
  try {
    const executable = execFileSync("which", ["dotnet"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.dirname(fs.realpathSync(executable));
  } catch {
    return "/usr/share/dotnet";
  }
}

function buildHelper() {
  const source = fs.readFileSync(path.join(__dirname, "csharp-facts.cs"));
  const fingerprint = crypto.createHash("sha256").update("copy-local-roslyn-v1\0").update(source).digest("hex").slice(0, 16);
  const target = path.join(os.tmpdir(), `flopeek-csharp-facts-${fingerprint}`);
  const helper = path.join(target, "Flopeek.CSharpFacts.dll");
  if (fs.existsSync(helper)) return helper;
  const sdkRoot = path.join(dotnetRoot(), "sdk");
  let sdk;
  try { sdk = fs.readdirSync(sdkRoot).sort().at(-1); } catch { return null; }
  const roslyn = path.join(sdkRoot, sdk, "Roslyn", "bincore");
  if (!fs.existsSync(path.join(roslyn, "Microsoft.CodeAnalysis.CSharp.dll"))) return null;
  const work = `${target}.build-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path.join(__dirname, "csharp-facts.cs"), path.join(work, "Program.cs"));
    fs.writeFileSync(path.join(work, "Flopeek.CSharpFacts.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${sdk.split(".").slice(0, 1)[0]}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Reference Include="Microsoft.CodeAnalysis"><HintPath>${path.join(roslyn, "Microsoft.CodeAnalysis.dll")}</HintPath><Private>true</Private></Reference><Reference Include="Microsoft.CodeAnalysis.CSharp"><HintPath>${path.join(roslyn, "Microsoft.CodeAnalysis.CSharp.dll")}</HintPath><Private>true</Private></Reference></ItemGroup></Project>`);
    execFileSync(process.platform === "win32" ? "dotnet.exe" : "dotnet", ["build", path.join(work, "Flopeek.CSharpFacts.csproj"), "-c", "Release", "-o", target, "--nologo"], { stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
    return fs.existsSync(helper) ? helper : null;
  } catch { return null; } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

function csharpFacts(files) {
  if (!files.length) return new Map();
  if (!helperPath && !attempted) { attempted = true; helperPath = buildHelper(); }
  if (!helperPath) return new Map();
  try {
    const output = execFileSync(process.platform === "win32" ? "dotnet.exe" : "dotnet", [helperPath], { input: JSON.stringify({ files }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: helperTimeout(60_000), maxBuffer: 32 * 1024 * 1024 });
    return new Map((JSON.parse(output).facts || []).map((fact) => [path.resolve(fact.file), fact]));
  } catch { return new Map(); }
}

module.exports = { csharpFacts };

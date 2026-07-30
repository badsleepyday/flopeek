using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

record Position(int line, int column);
record Range(Position start, Position end);
record ImportFact(string specifier, Range range);
record SymbolFact(string type, string name, List<string> methods, Range range);
record FileFact(string file, List<ImportFact> imports, List<SymbolFact> symbols, List<string> methods, string status, int diagnostics, string? reason);
record Input(List<string> files);
record Output(List<FileFact> facts);

public static class Program {
static void TestLifecycleHook() {
  if (Environment.GetEnvironmentVariable("FLOPEEK_TEST_MODE") != "1") return;
  var pidFile = Environment.GetEnvironmentVariable("FLOPEEK_TEST_HELPER_PID_FILE");
  if (!string.IsNullOrWhiteSpace(pidFile)) File.WriteAllText(pidFile, Environment.ProcessId.ToString());
  if (int.TryParse(Environment.GetEnvironmentVariable("FLOPEEK_TEST_HELPER_DELAY_MS"), out var milliseconds) && milliseconds > 0) Thread.Sleep(milliseconds);
}

static Range RangeOf(SyntaxNode node) {
  var span = node.GetLocation().GetLineSpan();
  return new Range(new Position(span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1), new Position(span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1));
}

public static async Task Main() {
TestLifecycleHook();
var input = await JsonSerializer.DeserializeAsync<Input>(Console.OpenStandardInput()) ?? new Input([]);
var facts = new List<FileFact>();
foreach (var file in input.files) {
  try {
    var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file);
    var root = await tree.GetRootAsync();
    var errors = tree.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToList();
    var imports = root.DescendantNodes().OfType<UsingDirectiveSyntax>()
      .Select(usingDirective => new ImportFact(usingDirective.Name?.ToString() ?? "", RangeOf(usingDirective)))
      .Where(importFact => importFact.specifier.Length > 0).ToList();
    var symbols = new List<SymbolFact>();
    foreach (var declaration in root.DescendantNodes().OfType<TypeDeclarationSyntax>()) {
      var methods = declaration.Members.OfType<MethodDeclarationSyntax>().Select(method => method.Identifier.Text).ToList();
      var type = declaration is InterfaceDeclarationSyntax ? "class" : "class";
      symbols.Add(new SymbolFact(type, declaration.Identifier.Text, methods, RangeOf(declaration)));
    }
    // Roslyn and Tree-sitter recover malformed syntax differently.  The
    // compatibility contract records only whether any syntax error exists,
    // never the parser-specific number of recovery nodes or diagnostics.
    var syntaxDiagnostic = errors.Count == 0 ? 0 : 1;
    facts.Add(new FileFact(file, imports, symbols, symbols.SelectMany(symbol => symbol.methods).Distinct().ToList(), syntaxDiagnostic == 0 ? "parsed" : "parsed-with-diagnostics", syntaxDiagnostic, syntaxDiagnostic == 0 ? null : "C# source contains one or more syntax errors."));
  } catch (Exception error) {
    facts.Add(new FileFact(file, [], [], [], "parse-failed", 1, error.Message));
  }
}
await JsonSerializer.SerializeAsync(Console.OpenStandardOutput(), new Output(facts));
}
}

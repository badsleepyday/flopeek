package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

type Position struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

type ImportFact struct {
	Specifier string `json:"specifier"`
	Standard  bool   `json:"standard"`
	Range     Range  `json:"range"`
}

type SymbolFact struct {
	Type    string   `json:"type"`
	Name    string   `json:"name"`
	Methods []string `json:"methods"`
	Range   Range    `json:"range"`
}

type SourceFact struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type ImportedCallFact struct {
	Specifier    string `json:"specifier"`
	ExportedName string `json:"exportedName"`
}

type CallFact struct {
	Name     string            `json:"name"`
	Source   *SourceFact       `json:"source,omitempty"`
	Imported *ImportedCallFact `json:"imported,omitempty"`
	Range    Range             `json:"range"`
}

type FileFact struct {
	File        string       `json:"file"`
	Imports     []ImportFact `json:"imports"`
	Symbols     []SymbolFact `json:"symbols"`
	Calls       []CallFact   `json:"calls"`
	Methods     []string     `json:"methods"`
	Status      string       `json:"status"`
	Diagnostics int          `json:"diagnostics"`
	Reason      string       `json:"reason,omitempty"`
}

type Input struct {
	Files []string `json:"files"`
}

type Output struct {
	Facts []FileFact `json:"facts"`
}

func testLifecycleHook() {
	if os.Getenv("FLOWPEEK_TEST_MODE") != "1" {
		return
	}
	if target := os.Getenv("FLOWPEEK_TEST_HELPER_PID_FILE"); target != "" {
		_ = os.WriteFile(target, []byte(strconv.Itoa(os.Getpid())), 0600)
	}
	if milliseconds, err := strconv.Atoi(os.Getenv("FLOWPEEK_TEST_HELPER_DELAY_MS")); err == nil && milliseconds > 0 {
		time.Sleep(time.Duration(milliseconds) * time.Millisecond)
	}
}

func position(fset *token.FileSet, pos token.Pos) Position {
	p := fset.Position(pos)
	return Position{Line: p.Line, Column: p.Column}
}

func sourceRange(fset *token.FileSet, node ast.Node) Range {
	return Range{Start: position(fset, node.Pos()), End: position(fset, node.End())}
}

func isStandardImport(specifier string) bool {
	if specifier == "C" {
		return true
	}
	info, err := os.Stat(filepath.Join(runtime.GOROOT(), "src", filepath.FromSlash(specifier)))
	return err == nil && info.IsDir()
}

func receiverTypeName(receiver *ast.FieldList) string {
	if receiver == nil || len(receiver.List) == 0 {
		return ""
	}
	var expression ast.Expr = receiver.List[0].Type
	for {
		switch node := expression.(type) {
		case *ast.StarExpr:
			expression = node.X
		case *ast.IndexExpr:
			expression = node.X
		case *ast.IndexListExpr:
			expression = node.X
		case *ast.Ident:
			return node.Name
		default:
			return ""
		}
	}
}

func functionSymbolName(declaration *ast.FuncDecl) string {
	if receiverType := receiverTypeName(declaration.Recv); receiverType != "" {
		return receiverType + "." + declaration.Name.Name
	}
	return declaration.Name.Name
}

func addFieldNames(names map[string]bool, fields *ast.FieldList) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			names[name.Name] = true
		}
	}
}

func addAssignedNames(names map[string]bool, expressions []ast.Expr) {
	for _, expression := range expressions {
		if identifier, ok := expression.(*ast.Ident); ok {
			names[identifier.Name] = true
		}
	}
}

func functionBoundNames(declaration *ast.FuncDecl) map[string]bool {
	names := map[string]bool{}
	addFieldNames(names, declaration.Recv)
	addFieldNames(names, declaration.Type.Params)
	addFieldNames(names, declaration.Type.Results)
	if declaration.Body == nil {
		return names
	}
	ast.Inspect(declaration.Body, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.FuncLit:
			return false
		case *ast.AssignStmt:
			addAssignedNames(names, value.Lhs)
		case *ast.ValueSpec:
			for _, name := range value.Names {
				names[name.Name] = true
			}
		case *ast.RangeStmt:
			addAssignedNames(names, []ast.Expr{value.Key, value.Value})
		case *ast.TypeSwitchStmt:
			if assignment, ok := value.Assign.(*ast.AssignStmt); ok {
				addAssignedNames(names, assignment.Lhs)
			}
		case *ast.CommClause:
			if assignment, ok := value.Comm.(*ast.AssignStmt); ok {
				addAssignedNames(names, assignment.Lhs)
			}
		}
		return true
	})
	return names
}

func importBindings(file *ast.File) map[string]string {
	bindings := map[string]string{}
	for _, spec := range file.Imports {
		specifier, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			continue
		}
		name := ""
		if spec.Name != nil {
			name = spec.Name.Name
		} else {
			name = path.Base(specifier)
		}
		if name != "" && name != "." && name != "_" {
			bindings[name] = specifier
		}
	}
	return bindings
}

func appendFunctionCalls(fact *FileFact, fset *token.FileSet, declaration *ast.FuncDecl, functions map[string]bool, imports map[string]string) {
	if declaration.Body == nil {
		return
	}
	source := &SourceFact{Type: "function", Name: functionSymbolName(declaration)}
	boundNames := functionBoundNames(declaration)
	ast.Inspect(declaration.Body, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.FuncLit:
			return false
		case *ast.CallExpr:
			switch callee := value.Fun.(type) {
			case *ast.Ident:
				if functions[callee.Name] && !boundNames[callee.Name] {
					fact.Calls = append(fact.Calls, CallFact{Name: callee.Name, Source: source, Range: sourceRange(fset, value)})
				}
			case *ast.SelectorExpr:
				qualifier, ok := callee.X.(*ast.Ident)
				if !ok || boundNames[qualifier.Name] {
					break
				}
				if specifier, found := imports[qualifier.Name]; found {
					fact.Calls = append(fact.Calls, CallFact{Name: callee.Sel.Name, Source: source, Imported: &ImportedCallFact{Specifier: specifier, ExportedName: callee.Sel.Name}, Range: sourceRange(fset, value)})
				}
			}
		}
		return true
	})
}

func main() {
	testLifecycleHook()
	var input Input
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		json.NewEncoder(os.Stdout).Encode(Output{})
		return
	}
	output := Output{Facts: make([]FileFact, 0, len(input.Files))}
	for _, filename := range input.Files {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, filename, nil, parser.ParseComments)
		fact := FileFact{File: filename, Imports: []ImportFact{}, Symbols: []SymbolFact{}, Calls: []CallFact{}, Methods: []string{}, Status: "parsed"}
		if err != nil {
			fact.Diagnostics = 1
			fact.Reason = err.Error()
			if file == nil {
				fact.Status = "parse-failed"
			} else {
				fact.Status = "parsed-with-diagnostics"
			}
		}
		if file == nil {
			output.Facts = append(output.Facts, fact)
			continue
		}
		typeSymbols := map[string]int{}
		typeMethods := map[string][]string{}
		topLevelFunctions := map[string]bool{}
		for _, spec := range file.Imports {
			value, quoteErr := strconv.Unquote(spec.Path.Value)
			if quoteErr == nil {
				fact.Imports = append(fact.Imports, ImportFact{Specifier: value, Standard: isStandardImport(value), Range: sourceRange(fset, spec)})
			}
		}
		for _, declaration := range file.Decls {
			switch node := declaration.(type) {
			case *ast.GenDecl:
				if node.Tok != token.TYPE {
					continue
				}
				for _, spec := range node.Specs {
					typeSpec, ok := spec.(*ast.TypeSpec)
					if !ok {
						continue
					}
					switch typeSpec.Type.(type) {
					case *ast.StructType, *ast.InterfaceType:
						typeSymbols[typeSpec.Name.Name] = len(fact.Symbols)
						fact.Symbols = append(fact.Symbols, SymbolFact{Type: "class", Name: typeSpec.Name.Name, Methods: []string{}, Range: sourceRange(fset, typeSpec)})
					}
				}
			case *ast.FuncDecl:
				fact.Symbols = append(fact.Symbols, SymbolFact{Type: "function", Name: functionSymbolName(node), Methods: []string{}, Range: sourceRange(fset, node)})
				fact.Methods = append(fact.Methods, node.Name.Name)
				if receiverType := receiverTypeName(node.Recv); receiverType != "" {
					typeMethods[receiverType] = append(typeMethods[receiverType], node.Name.Name)
				} else {
					topLevelFunctions[node.Name.Name] = true
				}
			}
		}
		for typeName, methods := range typeMethods {
			if typeIndex, found := typeSymbols[typeName]; found {
				fact.Symbols[typeIndex].Methods = methods
			}
		}
		imports := importBindings(file)
		for _, declaration := range file.Decls {
			if function, ok := declaration.(*ast.FuncDecl); ok {
				appendFunctionCalls(&fact, fset, function, topLevelFunctions, imports)
			}
		}
		output.Facts = append(output.Facts, fact)
	}
	json.NewEncoder(os.Stdout).Encode(output)
}

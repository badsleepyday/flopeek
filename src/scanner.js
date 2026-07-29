const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const ts = require("typescript");
const { goFacts } = require("./go-adapter");
const { csharpFacts } = require("./csharp-adapter");
const { frameworkRoute } = require("./framework-route");
const { classifyFile, deriveDomain, deriveFeature, isTestPath, titleCase } = require("./source-classification");
const { analyzeCSharpFact, analyzeGoFact, analyzeInventory } = require("./structural-fact-adapter");
const { adapterForPath, getAdapterRegistry } = require("./adapter-registry");
const { readGitMetadata } = require("./git-metadata");
const { CONFIG_FILENAME, classifyRepositoryPath, readRepositoryScope, scopeSignature, scopeSummary } = require("./scope");
const { GRAPH_SCHEMA_VERSION } = require("./graph-schema");
const { readGraphCache } = require("./graph-cache");
const { persistGraphState } = require("./graph-state");
const { advanceSessionGraph } = require("./session-graph-state");
const { resolveProjectIdentity } = require("./project-identity");
const { createFrameworkCommandFlowEntry, createHttpFlowEntry, createNodeCronScheduleFlowEntry, createPackageScriptFlowEntry, isSupportedFlowEntryNode } = require("./flow-entry");

const ADAPTER_REGISTRY = getAdapterRegistry();
const RESOLVE_EXTENSIONS = ["", ".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".svelte", ".vue", ".json"];
const JS_TS_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".flopeek", ".flowpeek", ".git", ".next", ".nuxt", ".project-flow", ".turbo", "build", "coverage", "dist", "node_modules", "out", "target", "vendor",
]);
const NODE_BUILTINS = new Set(require("node:module").builtinModules.map((name) => name.replace("node:", "")));
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DEV_TOOL_NAMES = new Set(["vite", "vitest", "eslint", "prettier", "tailwindcss", "postcss", "typescript", "tsx", "drizzle-kit", "playwright", "storybook", "pgtyped"]);
const BUNDLER_CONFIG_FILENAMES = ["vite.config.js", "vite.config.cjs", "vite.config.mjs", "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.tsx", "webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts", "webpack.config.mts", "webpack.config.cts", "webpack.config.tsx"];
const RUNTIME_FACTORIES = {
  "@prisma/client": { PrismaClient: { type: "database", label: "Prisma client", invocation: "new" } },
  typeorm: { DataSource: { type: "database", label: "TypeORM data source", invocation: "new" }, createConnection: { type: "database", label: "TypeORM connection", invocation: "call" } },
  "drizzle-orm": { drizzle: { type: "database", label: "Drizzle database", invocation: "call" } },
  bullmq: { Queue: { type: "queue", label: "Queue", invocation: "new" }, Worker: { type: "queue", label: "Worker", invocation: "new" }, FlowProducer: { type: "queue", label: "Flow producer", invocation: "new" } },
};
const DATABASE_OPERATION_NAMES = new Set(["find", "findFirst", "findMany", "findUnique", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert", "query", "execute", "select", "insert", "transaction", "getRepository"]);
const QUEUE_OPERATION_NAMES = new Set(["add", "addBulk", "close", "pause", "resume", "obliterate"]);
const DIRECT_SCRIPT_RUNNERS = new Set(["node", "nodejs", "tsx", "ts-node", "bun", "python", "python3", "php"]);
const SCRIPT_SHELL_SYNTAX = new Set(["|", "&", ";", "<", ">", "$", "`", "\"", "'", "\\", "\r", "\n"]);
let phpParser;
let pythonParser;
let javaTreeParser;
let rustTreeParser;

function getPhpParser() {
  if (!phpParser) {
    const PhpParser = require("php-parser");
    phpParser = new PhpParser({ parser: { version: 803, suppressErrors: true }, ast: { withPositions: true } });
  }
  return phpParser;
}

function getPythonParser() {
  if (!pythonParser) pythonParser = require("@lezer/python").parser;
  return pythonParser;
}

function getTreeParser(languagePackage) {
  const TreeSitter = require("tree-sitter");
  const parser = new TreeSitter();
  parser.setLanguage(require(languagePackage));
  return parser;
}

function getJavaTreeParser() {
  if (!javaTreeParser) javaTreeParser = getTreeParser("tree-sitter-java");
  return javaTreeParser;
}

function getRustTreeParser() {
  if (!rustTreeParser) rustTreeParser = getTreeParser("tree-sitter-rust");
  return rustTreeParser;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function extensionOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

function sourceAdapterForPath(filePath) {
  return adapterForPath(filePath, ADAPTER_REGISTRY);
}

function isRegisteredSourcePath(filePath) {
  return Boolean(sourceAdapterForPath(filePath));
}

function sourceDescriptor(filePath) {
  const extension = extensionOf(filePath);
  const filename = path.basename(filePath).toLowerCase();
  if (filename === "makefile") return { extension: ".makefile", language: "makefile" };
  if (extension === ".asm") return { extension, language: "assembly" };
  return { extension, language: extension.slice(1) || "unknown" };
}

function removeExtension(filePath) {
  const extension = path.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function walk(root, directory = root, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) walk(root, path.join(directory, entry.name), output);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolute = path.join(directory, entry.name);
    if (isRegisteredSourcePath(entry.name) && fs.statSync(absolute).size <= 1_000_000) output.push(absolute);
  }
  return output;
}

function safelyReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readDescriptions(root) {
  const current = path.join(root, ".flopeek", "descriptions.json");
  if (fs.existsSync(current)) return safelyReadJson(current, {});
  return safelyReadJson(path.join(root, ".project-flow", "descriptions.json"), {});
}

function scriptKind(extension) {
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isExported(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasHttpMethodName(node) {
  return Boolean(node.name && HTTP_METHODS.has(node.name.text));
}

function classMethodNames(node) {
  return node.members
    .filter((member) => ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name))
    .map((member) => member.name.text);
}

function evidenceFor(sourceFile, node, relativePath, parser) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    parser,
    file: relativePath,
    range: { start: { line: start.line + 1, column: start.character + 1 }, end: { line: end.line + 1, column: end.character + 1 } },
  };
}

function memberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function receiverName(expression) {
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const receiver = expression.expression;
  return ts.isIdentifier(receiver) ? receiver.text.toLowerCase() : null;
}

function stringLiteralValue(node) {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function fetchMethod(node) {
  const options = node.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return "GET";
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== "method") continue;
    const method = stringLiteralValue(property.initializer)?.toUpperCase();
    return HTTP_METHODS.has(method) ? method : "GET";
  }
  return "GET";
}

function joinHttpRoute(base = "", route = "") {
  const segments = [base, route]
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return segments.length ? `/${segments.join("/")}` : "/";
}

function namedImportBindings(sourceFile, moduleName) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) bindings.set(element.name.text, element.propertyName?.text || element.name.text);
  }
  return bindings;
}

function namedImportReferences(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          bindings.set(element.name.text, { specifier: statement.moduleSpecifier.text, exportedName: element.propertyName?.text || element.name.text });
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer) || !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== "require") continue;
        const specifier = stringLiteralValue(declaration.initializer.arguments[0]);
        if (!specifier) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          bindings.set(element.name.text, { specifier, exportedName: element.propertyName?.getText(sourceFile) || element.name.text });
        }
      }
    }
  }
  return bindings;
}

function enclosingTopLevelSymbol(node, sourceFile) {
  for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
    if (ts.isClassDeclaration(current) && current.parent === sourceFile && current.name && ts.isIdentifier(current.name)) return { type: "class", name: current.name.text };
    if (ts.isFunctionDeclaration(current) && current.parent === sourceFile && current.name && ts.isIdentifier(current.name)) return { type: "function", name: current.name.text };
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && ts.isVariableDeclarationList(current.parent) && ts.isVariableStatement(current.parent.parent) && current.parent.parent.parent === sourceFile) {
      return { type: "function", name: current.name.text };
    }
  }
  return null;
}

function bindingHasName(binding, name) {
  return Boolean(binding && ts.isIdentifier(binding.name) && binding.name.text === name);
}

function declarationListHasName(list, name) {
  return Boolean(list?.declarations?.some((declaration) => bindingHasName(declaration, name)));
}

function blockShadowsName(block, name) {
  return block.statements.some((statement) => {
    if (ts.isVariableStatement(statement)) return declarationListHasName(statement.declarationList, name);
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text === name;
    return false;
  });
}

function callNameIsShadowed(node, name, sourceFile) {
  for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
    if (current.parameters?.some((parameter) => bindingHasName(parameter, name))) return true;
    if (ts.isBlock(current) && blockShadowsName(current, name)) return true;
    if (ts.isCatchClause(current) && bindingHasName(current.variableDeclaration, name)) return true;
    if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) && current.initializer && ts.isVariableDeclarationList(current.initializer) && declarationListHasName(current.initializer, name)) return true;
  }
  return false;
}

function runtimeIntegrationFacts(sourceFile, relativePath) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const factories = RUNTIME_FACTORIES[statement.moduleSpecifier.text];
    const named = statement.importClause?.namedBindings;
    if (!factories || !named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const exported = element.propertyName?.text || element.name.text;
      if (factories[exported]) bindings.set(element.name.text, { ...factories[exported], package: statement.moduleSpecifier.text });
    }
  }
  const integrations = [];
  const runtimeActions = [];
  const instances = new Map();
  const rootIdentifier = (expression) => {
    let current = expression;
    while (ts.isPropertyAccessExpression(current)) current = current.expression;
    return ts.isIdentifier(current) ? current.text : null;
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isNewExpression(node.initializer) || ts.isCallExpression(node.initializer)) && ts.isIdentifier(node.initializer.expression)) {
      const binding = bindings.get(node.initializer.expression.text);
      const invocation = ts.isNewExpression(node.initializer) ? "new" : "call";
      if (binding?.invocation === invocation) {
        const queueName = binding.type === "queue" ? stringLiteralValue(node.initializer.arguments?.[0]) : null;
        const integration = { instance: node.name.text, type: binding.type, package: binding.package, label: queueName ? `${queueName} ${binding.label}` : binding.label, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") };
        integrations.push(integration);
        instances.set(integration.instance, integration);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const instance = instances.get(rootIdentifier(node.expression));
      const method = node.expression.name.text;
      const action = instance?.type === "database" && DATABASE_OPERATION_NAMES.has(method) ? "queries" : instance?.type === "queue" && QUEUE_OPERATION_NAMES.has(method) ? "queues" : null;
      if (action) runtimeActions.push({ instance: instance.instance, type: action, source: enclosingTopLevelSymbol(node, sourceFile), evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { integrations, runtimeActions };
}

function decoratorsFor(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}

function decoratorCall(node) {
  if (!ts.isDecorator(node) || !ts.isCallExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) return null;
  return { name: node.expression.expression.text, argument: stringLiteralValue(node.expression.arguments[0]) || "" };
}

function nestEndpoints(sourceFile, relativePath) {
  const bindings = namedImportBindings(sourceFile, "@nestjs/common");
  if (!bindings.size) return [];
  const endpoints = [];
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) {
      const controller = decoratorsFor(node)
        .map(decoratorCall)
        .find((decorator) => decorator && bindings.get(decorator.name) === "Controller");
      if (controller) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          for (const decorator of decoratorsFor(member).map(decoratorCall)) {
            const method = decorator && bindings.get(decorator.name);
            if (method && HTTP_METHODS.has(method.toUpperCase())) {
              endpoints.push({
                method: method.toUpperCase(),
                route: joinHttpRoute(controller.argument, decorator.argument),
                evidence: evidenceFor(sourceFile, member, relativePath, "typescript-ast"),
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return endpoints;
}

function nodeCronDefaultBindings(sourceFile) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "node-cron") continue;
    if (statement.importClause?.name) bindings.add(statement.importClause.name.text);
  }
  return bindings;
}

function literalCronExpression(node) {
  const value = stringLiteralValue(node);
  if (!value || value.length > 128) return null;
  const fields = value.trim().split(/\s+/);
  if (![5, 6].includes(fields.length)) return null;
  if (fields.some((field) => !/^[0-9A-Z*/?,\-]+$/i.test(field))) return null;
  return value;
}

function isModuleScope(node, sourceFile) {
  for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isModuleDeclaration(current)) return false;
  }
  return true;
}

function nodeCronSchedules(sourceFile, relativePath) {
  const receivers = nodeCronDefaultBindings(sourceFile);
  if (!receivers.size) return { schedules: [], unsupportedSchedules: [] };
  const schedules = [];
  const unsupportedSchedules = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "schedule"
      && ts.isIdentifier(node.expression.expression)
      && receivers.has(node.expression.expression.text)
      && !callNameIsShadowed(node, node.expression.expression.text, sourceFile)) {
      const expression = literalCronExpression(node.arguments[0]);
      const task = node.arguments[1];
      const taskName = ts.isIdentifier(task) && !callNameIsShadowed(node, task.text, sourceFile) ? task.text : null;
      if (!isModuleScope(node, sourceFile)) {
        unsupportedSchedules.push({ path: relativePath, reason: "registration-is-not-module-scope" });
      } else if (expression && taskName) {
        schedules.push({ expression, taskName, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
      } else {
        unsupportedSchedules.push({
          path: relativePath,
          reason: !expression ? "non-literal-or-unsupported-cron-expression" : "task-is-not-an-unshadowed-identifier",
          evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast"),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { schedules, unsupportedSchedules };
}

function fastifyReceivers(sourceFile) {
  const factories = new Set();
  const receivers = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "fastify") continue;
    if (statement.importClause?.name) factories.add(statement.importClause.name.text);
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) if ((element.propertyName?.text || element.name.text) === "fastify") factories.add(element.name.text);
    }
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      if (ts.isIdentifier(node.initializer.expression) && factories.has(node.initializer.expression.text)) receivers.add(node.name.text.toLowerCase());
      if (ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require" && ts.isStringLiteralLike(node.initializer.arguments[0]) && node.initializer.arguments[0].text === "fastify") factories.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return receivers;
}

function contractPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function contractFieldType(node) {
  if (!node) return "unknown";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) return "array";
  if (ts.isTypeLiteralNode(node)) return "object";
  if (ts.isLiteralTypeNode(node)) return contractFieldType(node.literal);
  return "unknown";
}

function staticTypeLiteralFields(sourceFile, typeNode, relativePath) {
  if (!typeNode || !ts.isTypeLiteralNode(typeNode)) return null;
  const fields = [];
  for (const member of typeNode.members) {
    if (!ts.isPropertySignature(member) || !member.name) return null;
    const name = contractPropertyName(member.name);
    if (!name) return null;
    fields.push({
      name,
      required: !member.questionToken,
      type: contractFieldType(member.type),
      evidence: evidenceFor(sourceFile, member, relativePath, "typescript-ast"),
    });
  }
  return fields.sort((left, right) => left.name.localeCompare(right.name));
}

function staticObjectLiteralFields(sourceFile, object, relativePath) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  const fields = [];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    if (ts.isPropertyAssignment(property)) {
      const name = contractPropertyName(property.name);
      if (!name) return null;
      fields.push({ name, required: true, type: contractFieldType(property.initializer), evidence: evidenceFor(sourceFile, property, relativePath, "typescript-ast") });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      fields.push({ name: property.name.text, required: true, type: "unknown", evidence: evidenceFor(sourceFile, property, relativePath, "typescript-ast") });
      continue;
    }
    return null;
  }
  return fields.sort((left, right) => left.name.localeCompare(right.name));
}

function requestJsonTypeLiteral(call) {
  let current = call;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if ((ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) && parent.expression === current) return parent.type;
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) return parent.type || null;
    return null;
  }
  return null;
}

function isRequestJsonCall(node, requestName) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "json"
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === requestName;
}

function isResponseJsonCall(node) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "json"
    && ts.isIdentifier(node.expression.expression)
    && ["Response", "NextResponse"].includes(node.expression.expression.text);
}

function explicitResponseStatus(node) {
  const options = node.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || contractPropertyName(property.name) !== "status" || !ts.isNumericLiteral(property.initializer)) continue;
    return Number(property.initializer.text);
  }
  return null;
}

function returnedByHandler(node, handler) {
  for (let current = node; current && current !== handler; current = current.parent) {
    if (ts.isReturnStatement(current)) return true;
    if (current !== node && ts.isFunctionLike(current)) return false;
  }
  return ts.isArrowFunction(handler) && handler.body === node;
}

function walkHandlerBody(handler, visit) {
  const walk = (node) => {
    if (node !== handler && ts.isFunctionLike(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  };
  if (handler.body) walk(handler.body);
}

function nextHandlerDefinitions(sourceFile) {
  const handlers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && hasHttpMethodName(statement)) handlers.push({ name: statement.name.text, node: statement });
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !HTTP_METHODS.has(declaration.name.text) || (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer))) continue;
      handlers.push({ name: declaration.name.text, node: declaration.initializer });
    }
  }
  return handlers;
}

function nextRouteHandlerContracts(sourceFile, relativePath, routeInfo) {
  const contracts = new Map();
  if (!routeInfo?.handler) return contracts;
  for (const handler of nextHandlerDefinitions(sourceFile)) {
    const requestName = handler.node.parameters[0] && ts.isIdentifier(handler.node.parameters[0].name) ? handler.node.parameters[0].name.text : null;
    const requestCandidates = [];
    const variants = [];
    walkHandlerBody(handler.node, (node) => {
      if (requestName && isRequestJsonCall(node, requestName)) {
        const fields = staticTypeLiteralFields(sourceFile, requestJsonTypeLiteral(node), relativePath);
        if (fields) requestCandidates.push(fields);
      }
      if (!isResponseJsonCall(node) || !returnedByHandler(node, handler.node)) return;
      const fields = staticObjectLiteralFields(sourceFile, node.arguments[0], relativePath);
      const status = explicitResponseStatus(node);
      if (!fields || !Number.isInteger(status)) return;
      variants.push({ status, fields, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
    });
    const requestFields = requestCandidates.length === 1 ? requestCandidates[0] : null;
    const responseVariants = [...new Map(variants.map((variant) => [`${variant.status}:${variant.fields.map((field) => `${field.name}:${field.type}:${field.required}`).join(",")}`, variant])).values()]
      .sort((left, right) => left.status - right.status || left.fields.map((field) => field.name).join(",").localeCompare(right.fields.map((field) => field.name).join(",")));
    contracts.set(handler.name, {
      schemaVersion: "flopeek-next-route-contract/v1",
      adapter: "next-route-handler",
      handlerName: handler.name,
      request: requestFields
        ? { status: "available", fields: requestFields, reason: null }
        : { status: "unavailable", fields: [], reason: requestName ? "No single inline TypeScript object-literal schema was found for this handler's request.json() call." : "The handler has no simple identifier request parameter for parser-backed payload extraction." },
      responses: responseVariants.length
        ? { status: "available", variants: responseVariants, reason: null }
        : { status: "unavailable", variants: [], reason: "No returned Response.json/NextResponse.json call with an object-literal body and explicit numeric status was found in this handler." },
    });
  }
  return contracts;
}

function analyzeJavaScriptTypeScript(content, extension, relativePath, routeInfo) {
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKind(extension));
  const imports = [];
  const endpoints = nestEndpoints(sourceFile, relativePath);
  const requests = [];
  const calls = [];
  const methods = [];
  const symbols = [];
  const runtime = runtimeIntegrationFacts(sourceFile, relativePath);
  const schedules = nodeCronSchedules(sourceFile, relativePath);
  const fastifyInstances = fastifyReceivers(sourceFile);
  const importedBindings = namedImportReferences(sourceFile);
  const nextContracts = nextRouteHandlerContracts(sourceFile, relativePath, routeInfo);
  const addImport = (specifier, node) => imports.push({ specifier, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, node);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, node);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) addImport(node.moduleReference.expression.text, node);
    if (ts.isCallExpression(node)) {
      const method = memberName(node.expression)?.toUpperCase();
      const receiver = receiverName(node.expression);
      const routeArgument = node.arguments[0];
      if (HTTP_METHODS.has(method) && (["app", "router", "server"].includes(receiver) || fastifyInstances.has(receiver)) && routeArgument && ts.isStringLiteralLike(routeArgument)) {
        endpoints.push({ method, route: routeArgument.text, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        const route = stringLiteralValue(node.arguments[0]);
        if (route && route.startsWith("/")) requests.push({ method: fetchMethod(node), route, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) addImport(node.arguments[0].text, node);
      if (ts.isIdentifier(node.expression) && node.expression.text !== "require" && !callNameIsShadowed(node, node.expression.text, sourceFile)) {
        calls.push({ name: node.expression.text, source: enclosingTopLevelSymbol(node, sourceFile), imported: importedBindings.get(node.expression.text) || null, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
      }
    }
    if (node.parent === sourceFile && ts.isClassDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      symbols.push({ type: "class", name: node.name.text, methods: classMethodNames(node), evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
    }
    if (node.parent === sourceFile && ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      symbols.push({ type: "function", name: node.name.text, methods: [], evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
    }
    if (node.parent === sourceFile && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer))) continue;
        symbols.push({ type: "function", name: declaration.name.text, methods: [], evidence: evidenceFor(sourceFile, declaration, relativePath, "typescript-ast") });
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) && isExported(node)) {
      if (ts.isFunctionDeclaration(node) && hasHttpMethodName(node) && routeInfo?.handler) endpoints.push({ method: node.name.text, route: routeInfo.route, handlerName: node.name.text, handlerType: "function", contract: nextContracts.get(node.name.text) || null, evidence: evidenceFor(sourceFile, node, relativePath, "typescript-ast") });
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (routeInfo?.handler && ts.isIdentifier(declaration.name) && HTTP_METHODS.has(declaration.name.text)) endpoints.push({ method: declaration.name.text, route: routeInfo.route, handlerName: declaration.name.text, handlerType: "function", contract: nextContracts.get(declaration.name.text) || null, evidence: evidenceFor(sourceFile, declaration, relativePath, "typescript-ast") });
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name && ts.isIdentifier(node.name)) methods.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    imports,
    endpoints,
    requests,
    calls,
    integrations: runtime.integrations,
    runtimeActions: runtime.runtimeActions,
    schedules: schedules.schedules,
    unsupportedSchedules: schedules.unsupportedSchedules,
    methods: [...new Set(methods)].slice(0, 12),
    symbols,
    analysis: { parser: "typescript-ast", status: sourceFile.parseDiagnostics.length ? "parsed-with-diagnostics" : "parsed", confidence: "exact", diagnostics: sourceFile.parseDiagnostics.length },
  };
}

function phpName(node) {
  if (typeof node === "string") return node;
  return typeof node?.name === "string" ? node.name : null;
}

function phpEvidence(node, relativePath) {
  const location = node?.loc;
  return {
    parser: "php-parser",
    file: relativePath,
    range: {
      start: { line: (location?.start?.line || 1), column: (location?.start?.column || 0) + 1 },
      end: { line: (location?.end?.line || location?.start?.line || 1), column: (location?.end?.column || location?.start?.column || 0) + 1 },
    },
  };
}

function visitPhpAst(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) visitPhpAst(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.kind === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "errors") continue;
    visitPhpAst(value, visit);
  }
}

function phpTopLevelDeclarations(nodes, declarations) {
  for (const node of nodes || []) {
    if (!node || typeof node !== "object") continue;
    if (node.kind === "namespace") {
      phpTopLevelDeclarations(node.children, declarations);
      continue;
    }
    if (["class", "interface", "trait", "enum", "function"].includes(node.kind)) declarations.push(node);
  }
}

function phpUseSpecifier(group, item) {
  const prefix = phpName(group.name);
  const name = phpName(item.name);
  if (!name) return null;
  return prefix ? `${prefix}\\${name}` : name;
}

function analyzePhp(content, relativePath) {
  let ast;
  try {
    ast = getPhpParser().parseCode(content, relativePath);
  } catch (error) {
    return {
      imports: [], endpoints: [], requests: [], calls: [], methods: [], symbols: [],
      analysis: { parser: "php-parser", status: "parse-failed", confidence: "not-analyzed", diagnostics: 1, reason: error.message || "PHP parser failed." },
    };
  }

  const imports = [];
  visitPhpAst(ast, (node) => {
    if (node.kind !== "usegroup") return;
    for (const item of node.items || []) {
      const specifier = phpUseSpecifier(node, item);
      if (specifier) imports.push({ specifier, evidence: phpEvidence(item, relativePath) });
    }
  });

  const declarations = [];
  phpTopLevelDeclarations(ast.children, declarations);
  const symbols = [];
  const localFunctions = new Set();
  const methods = [];
  for (const declaration of declarations) {
    const name = phpName(declaration.name);
    if (!name) continue;
    if (declaration.kind === "function") {
      localFunctions.add(name);
      symbols.push({ type: "function", name, methods: [], evidence: phpEvidence(declaration, relativePath) });
      continue;
    }
    const declarationMethods = (declaration.body || [])
      .filter((member) => member.kind === "method")
      .map((member) => phpName(member.name))
      .filter(Boolean);
    methods.push(...declarationMethods);
    symbols.push({ type: "class", name, methods: declarationMethods, evidence: phpEvidence(declaration, relativePath) });
  }

  const calls = [];
  const declarationKinds = new Set(["class", "interface", "trait", "enum", "function"]);
  const visitExecution = (node, source = null) => {
    if (Array.isArray(node)) {
      for (const child of node) visitExecution(child, source);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (node.kind === "namespace") {
      visitExecution(node.children, source);
      return;
    }
    if (node.kind === "function") {
      const name = phpName(node.name);
      if (name) visitExecution(node.body, { type: "function", name });
      return;
    }
    if (["class", "interface", "trait", "enum"].includes(node.kind)) {
      const name = phpName(node.name);
      for (const member of node.body || []) if (member.kind === "method" && member.body && name) visitExecution(member.body, { type: "class", name });
      return;
    }
    if (node.kind === "closure" || node.kind === "arrowfunc") return;
    if (node.kind === "call") {
      const name = phpName(node.what);
      if (name && !name.includes("\\") && localFunctions.has(name)) calls.push({ name, source, imported: null, evidence: phpEvidence(node, relativePath) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "errors" || (value && declarationKinds.has(value.kind))) continue;
      visitExecution(value, source);
    }
  };
  visitExecution(ast.children);

  const diagnostics = Array.isArray(ast.errors) ? ast.errors.length : 0;
  return {
    imports,
    endpoints: [],
    requests: [],
    calls,
    methods: [...new Set(methods)].slice(0, 12),
    symbols,
    analysis: { parser: "php-parser", status: diagnostics ? "parsed-with-diagnostics" : "parsed", confidence: "exact", diagnostics },
  };
}

function treeText(source, node) {
  return node ? source.slice(node.startIndex, node.endIndex) : null;
}

function treeEvidence(node, relativePath, parser) {
  return {
    parser,
    file: relativePath,
    range: {
      start: { line: node.startPosition.row + 1, column: node.startPosition.column + 1 },
      end: { line: node.endPosition.row + 1, column: node.endPosition.column + 1 },
    },
  };
}

function treeErrorCount(node) {
  let count = node.type === "ERROR" || node.isMissing ? 1 : 0;
  for (const child of node.children) count += treeErrorCount(child);
  return count;
}

function parseTreeSource(parser, content) {
  // The Node Tree-sitter bridge asks string inputs through a fixed-size buffer.
  // Size it for the whole source so larger files do not make a repository scan fail.
  return parser.parse(content, undefined, { bufferSize: Math.max(32_769, Buffer.byteLength(content, "utf8") + 1) });
}

function javaTypeBody(node) {
  return node.childForFieldName("body") || node.namedChildren.find((child) => child.type.endsWith("_body")) || null;
}

function javaMethodDetails(typeDeclaration, content) {
  return (javaTypeBody(typeDeclaration)?.namedChildren || [])
    .filter((member) => member.type === "method_declaration")
    .map((method) => {
      const name = treeText(content, method.childForFieldName("name"));
      const modifiers = method.namedChildren.find((child) => child.type === "modifiers");
      const isStatic = Boolean(modifiers?.children.some((child) => child.type === "static"));
      return name ? { node: method, name, isStatic } : null;
    })
    .filter(Boolean);
}

function javaInvocationBelongsToMethod(invocation, method) {
  let current = invocation.parent;
  for (; current && current !== method; current = current.parent) {
    if (["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration", "lambda_expression"].includes(current.type)) return false;
  }
  return current === method;
}

function analyzeJava(content, relativePath) {
  const tree = parseTreeSource(getJavaTreeParser(), content);
  const root = tree.rootNode;
  const imports = root.namedChildren
    .filter((node) => node.type === "import_declaration")
    .map((node) => node.namedChildren.find((child) => child.type === "identifier" || child.type === "scoped_identifier"))
    .filter(Boolean)
    .map((node) => {
      const specifier = treeText(content, node);
      return { specifier, standard: specifier.startsWith("java.") || specifier.startsWith("javax."), evidence: treeEvidence(node, relativePath, "tree-sitter-java") };
    });
  const symbols = [];
  const calls = [];
  for (const declaration of root.namedChildren.filter((node) => ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"].includes(node.type))) {
    const typeName = treeText(content, declaration.childForFieldName("name"));
    if (!typeName) continue;
    const methods = javaMethodDetails(declaration, content);
    symbols.push({ type: "class", name: typeName, methods: methods.map((method) => method.name), evidence: treeEvidence(declaration, relativePath, "tree-sitter-java") });
    const staticNameCounts = new Map();
    for (const method of methods.filter((method) => method.isStatic)) staticNameCounts.set(method.name, (staticNameCounts.get(method.name) || 0) + 1);
    const uniqueStaticMethods = methods.filter((method) => method.isStatic && staticNameCounts.get(method.name) === 1);
    const uniqueStaticNames = new Set(uniqueStaticMethods.map((method) => method.name));
    for (const method of uniqueStaticMethods) {
      const qualifiedName = `${typeName}.${method.name}`;
      symbols.push({ type: "function", name: qualifiedName, methods: [], evidence: treeEvidence(method.node, relativePath, "tree-sitter-java") });
      const body = method.node.childForFieldName("body");
      for (const invocation of body?.descendantsOfType("method_invocation") || []) {
        if (!javaInvocationBelongsToMethod(invocation, method.node) || invocation.childForFieldName("object")) continue;
        const targetName = treeText(content, invocation.childForFieldName("name"));
        if (targetName && uniqueStaticNames.has(targetName)) calls.push({ name: `${typeName}.${targetName}`, source: { type: "function", name: qualifiedName }, imported: null, evidence: treeEvidence(invocation, relativePath, "tree-sitter-java") });
      }
    }
  }
  const diagnostics = root.hasError ? treeErrorCount(root) : 0;
  return {
    imports,
    endpoints: [],
    requests: [],
    calls,
    methods: [...new Set(symbols.flatMap((symbol) => symbol.methods))].slice(0, 12),
    symbols,
    analysis: { parser: "tree-sitter-java", status: diagnostics ? "parsed-with-diagnostics" : "parsed", confidence: "exact", diagnostics },
  };
}

function rustTypeName(node, content) {
  const type = node.childForFieldName("type");
  if (!type) return null;
  if (type.type === "type_identifier") return treeText(content, type);
  const nested = type.descendantsOfType("type_identifier")[0];
  return treeText(content, nested);
}

function rustDeclarationMethods(node, content) {
  const body = node.childForFieldName("body");
  return (body?.namedChildren || [])
    .filter((member) => member.type === "function_item" || member.type === "function_signature_item")
    .map((member) => treeText(content, member.childForFieldName("name")))
    .filter(Boolean);
}

function rustPathSegments(node, content) {
  if (!node) return [];
  if (["identifier", "crate", "self", "super"].includes(node.type)) {
    const segment = treeText(content, node);
    return segment ? [segment] : [];
  }
  if (node.type === "scoped_identifier") {
    return [
      ...rustPathSegments(node.childForFieldName("path"), content),
      ...rustPathSegments(node.childForFieldName("name"), content),
    ];
  }
  return [];
}

function rustImportFact(segments, evidence, localName = null) {
  const specifier = segments.join("::");
  const exportedName = segments.at(-1);
  const standard = ["std", "core", "alloc"].includes(segments[0]);
  const internal = ["crate", "self", "super"].includes(segments[0]);
  const binding = localName || (exportedName && exportedName !== "*" ? exportedName : null);
  return {
    specifier,
    language: "rust",
    standard,
    internal,
    ...(binding ? { binding: { localName: binding, exportedName } } : {}),
    evidence,
  };
}

function rustUseFacts(node, content, relativePath, prefix = []) {
  if (node.type === "scoped_use_list") {
    const nextPrefix = [...prefix, ...rustPathSegments(node.childForFieldName("path"), content)];
    const list = node.childForFieldName("list");
    return (list?.namedChildren || []).flatMap((child) => rustUseFacts(child, content, relativePath, nextPrefix));
  }
  if (node.type === "use_list") return node.namedChildren.flatMap((child) => rustUseFacts(child, content, relativePath, prefix));
  if (node.type === "use_as_clause") {
    const segments = [...prefix, ...rustPathSegments(node.childForFieldName("path"), content)];
    const alias = treeText(content, node.childForFieldName("alias"));
    return segments.length ? [rustImportFact(segments, treeEvidence(node, relativePath, "tree-sitter-rust"), alias || null)] : [];
  }
  if (node.type === "use_wildcard") {
    const segments = [...prefix, ...rustPathSegments(node.namedChildren[0], content), "*"];
    return segments.length > 1 ? [rustImportFact(segments, treeEvidence(node, relativePath, "tree-sitter-rust"))] : [];
  }
  const segments = [...prefix, ...rustPathSegments(node, content)];
  return segments.length ? [rustImportFact(segments, treeEvidence(node, relativePath, "tree-sitter-rust"))] : [];
}

function visitRustCalls(node, source, localFunctions, importedBindings, content, relativePath, calls) {
  if (node.type === "closure_expression") return;
  if (node.type === "call_expression") {
    const target = node.childForFieldName("function");
    if (target?.type === "identifier") {
      const name = treeText(content, target);
      if (localFunctions.has(name)) calls.push({ name, source, imported: null, evidence: treeEvidence(node, relativePath, "tree-sitter-rust") });
      else if (importedBindings.has(name)) calls.push({ name, source, imported: importedBindings.get(name), evidence: treeEvidence(node, relativePath, "tree-sitter-rust") });
    }
  }
  for (const child of node.namedChildren) visitRustCalls(child, source, localFunctions, importedBindings, content, relativePath, calls);
}

function analyzeRust(content, relativePath) {
  const tree = parseTreeSource(getRustTreeParser(), content);
  const root = tree.rootNode;
  const imports = root.namedChildren
    .filter((node) => node.type === "use_declaration")
    .map((node) => node.childForFieldName("argument"))
    .filter(Boolean)
    .flatMap((node) => rustUseFacts(node, content, relativePath));
  const importedBindings = new Map(imports
    .filter((imported) => imported.binding)
    .map((imported) => [imported.binding.localName, { specifier: imported.specifier, exportedName: imported.binding.exportedName }]));
  const typeDeclarations = root.namedChildren.filter((node) => ["struct_item", "enum_item", "trait_item", "union_item"].includes(node.type));
  const typeSymbols = new Map();
  for (const declaration of typeDeclarations) {
    const name = treeText(content, declaration.childForFieldName("name"));
    if (name) typeSymbols.set(name, { type: "class", name, methods: rustDeclarationMethods(declaration, content), evidence: treeEvidence(declaration, relativePath, "tree-sitter-rust") });
  }
  for (const implementation of root.namedChildren.filter((node) => node.type === "impl_item")) {
    const name = rustTypeName(implementation, content);
    const symbol = typeSymbols.get(name);
    if (symbol) symbol.methods.push(...rustDeclarationMethods(implementation, content));
  }
  const functionDeclarations = root.namedChildren.filter((node) => node.type === "function_item");
  const localFunctions = new Set(functionDeclarations.map((node) => treeText(content, node.childForFieldName("name"))).filter(Boolean));
  const symbols = [
    ...[...typeSymbols.values()].map((symbol) => ({ ...symbol, methods: [...new Set(symbol.methods)] })),
    ...functionDeclarations.map((node) => {
      const name = treeText(content, node.childForFieldName("name"));
      return name ? { type: "function", name, methods: [], evidence: treeEvidence(node, relativePath, "tree-sitter-rust") } : null;
    }).filter(Boolean),
  ];
  const calls = [];
  for (const declaration of functionDeclarations) {
    const name = treeText(content, declaration.childForFieldName("name"));
    const body = declaration.childForFieldName("body");
    if (name && body) visitRustCalls(body, { type: "function", name }, localFunctions, importedBindings, content, relativePath, calls);
  }
  for (const implementation of root.namedChildren.filter((node) => node.type === "impl_item")) {
    const name = rustTypeName(implementation, content);
    const body = implementation.childForFieldName("body");
    if (name && typeSymbols.has(name) && body) {
      for (const method of body.namedChildren.filter((node) => node.type === "function_item")) {
        const methodBody = method.childForFieldName("body");
        if (methodBody) visitRustCalls(methodBody, { type: "class", name }, localFunctions, importedBindings, content, relativePath, calls);
      }
    }
  }
  const diagnostics = root.hasError ? treeErrorCount(root) : 0;
  return {
    imports,
    endpoints: [],
    requests: [],
    calls,
    methods: [...new Set(symbols.filter((symbol) => symbol.type === "class").flatMap((symbol) => symbol.methods))].slice(0, 12),
    symbols,
    analysis: { parser: "tree-sitter-rust", status: diagnostics ? "parsed-with-diagnostics" : "parsed", confidence: "exact", diagnostics },
  };
}

function syntaxTreeChildren(node) {
  const children = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

function visitSyntaxTree(node, visit) {
  visit(node);
  for (const child of syntaxTreeChildren(node)) visitSyntaxTree(child, visit);
}

function findSyntaxTreeNode(node, name) {
  if (node.name === name) return node;
  for (const child of syntaxTreeChildren(node)) {
    const match = findSyntaxTreeNode(child, name);
    if (match) return match;
  }
  return null;
}

function pythonEvidence(content, node, relativePath) {
  return {
    parser: "python-lezer",
    file: relativePath,
    range: { start: positionFromOffset(content, node.from), end: positionFromOffset(content, node.to) },
  };
}

function pythonImportFacts(node, content) {
  const tokens = syntaxTreeChildren(node).map((child) => ({ name: child.name, text: content.slice(child.from, child.to) }));
  if (tokens[0]?.name === "import") {
    const imports = [];
    let specifier = "";
    let readingAlias = false;
    const finish = () => {
      if (specifier) imports.push(specifier);
      specifier = "";
      readingAlias = false;
    };
    for (const token of tokens.slice(1)) {
      if (token.name === ",") finish();
      else if (token.name === "as") readingAlias = true;
      else if (!readingAlias) specifier += token.text;
    }
    finish();
    return imports;
  }
  if (tokens[0]?.name !== "from") return [];
  let module = "";
  let hasModuleName = false;
  let readingModule = true;
  let readingAlias = false;
  const importedNames = [];
  for (const token of tokens.slice(1)) {
    if (token.name === "import") {
      readingModule = false;
      continue;
    }
    if (readingModule) {
      module += token.text;
      if (token.name === "VariableName") hasModuleName = true;
      continue;
    }
    if (token.name === ",") {
      readingAlias = false;
      continue;
    }
    if (token.name === "as") {
      readingAlias = true;
      continue;
    }
    if (!readingAlias && token.name === "VariableName") importedNames.push(token.text);
  }
  if (hasModuleName) return module ? [module] : [];
  return importedNames.map((name) => `${module}${name}`);
}

function pythonStringLiteral(content, node) {
  const text = content.slice(node.from, node.to);
  const quote = text[0];
  if ((quote !== "\"" && quote !== "'") || text.length < 2 || text.at(-1) !== quote) return null;
  const value = text.slice(1, -1);
  return value.includes("\\") ? null : value;
}

function pythonStringValues(node, content) {
  const values = [];
  visitSyntaxTree(node, (child) => {
    if (child.name !== "String") return;
    const value = pythonStringLiteral(content, child);
    if (value !== null) values.push(value);
  });
  return values;
}

function pythonRouteDecoratorMethods(argumentList, content) {
  const children = syntaxTreeChildren(argumentList);
  for (let index = 0; index < children.length; index += 1) {
    const candidate = children[index];
    if (candidate.name !== "VariableName" || content.slice(candidate.from, candidate.to) !== "methods") continue;
    const value = children[index + 2];
    if (children[index + 1]?.name !== "AssignOp") return { declared: true, methods: [] };
    if (value?.name !== "ArrayExpression") return { declared: true, methods: [] };
    return { declared: true, methods: pythonStringValues(value, content).map((method) => method.toUpperCase()).filter((method) => HTTP_METHODS.has(method)) };
  }
  return { declared: false, methods: [] };
}

function pythonDecoratorEndpoints(node, content, relativePath, routeReceivers) {
  const children = syntaxTreeChildren(node);
  const names = children.filter((child) => child.name === "VariableName").map((child) => content.slice(child.from, child.to).toLowerCase());
  const argumentList = children.find((child) => child.name === "ArgList");
  const routeNode = argumentList && findSyntaxTreeNode(argumentList, "String");
  const route = routeNode && pythonStringLiteral(content, routeNode);
  if (!route || !routeReceivers.has(names[0])) return [];
  const method = names[1]?.toUpperCase();
  const methods = HTTP_METHODS.has(method)
    ? [method]
    : names[1] === "route"
      ? (() => {
        const explicit = pythonRouteDecoratorMethods(argumentList, content);
        return explicit.declared ? explicit.methods : ["GET"];
      })()
      : [];
  return methods.map((httpMethod) => ({
    method: httpMethod,
    route,
    confidence: "likely",
    detectedResponsibility: "Possible HTTP endpoint detected from a Python framework decorator.",
    evidence: pythonEvidence(content, node, relativePath),
  }));
}

function pythonFlaskFactoryNames(importedBindings) {
  const names = new Set(["Flask", "Blueprint"]);
  for (const [localName, binding] of importedBindings) {
    if (binding.specifier === "flask" && ["Flask", "Blueprint"].includes(binding.exportedName)) names.add(localName);
  }
  return names;
}

function pythonFlaskRouteReceivers(root, content, factoryNames) {
  const receivers = new Set(["app", "api", "router", "server", "blueprint", "bp"]);
  visitSyntaxTree(root, (node) => {
    if (node.name !== "AssignStatement") return;
    const children = syntaxTreeChildren(node);
    const assignmentIndex = children.findIndex((child) => child.name === "AssignOp");
    if (assignmentIndex < 1) return;
    const targetNames = children.slice(0, assignmentIndex)
      .filter((child) => child.name === "VariableName")
      .map((child) => content.slice(child.from, child.to).toLowerCase());
    const call = children.slice(assignmentIndex + 1).find((child) => child.name === "CallExpression");
    const callee = call && syntaxTreeChildren(call).find((child) => child.name === "VariableName");
    if (!callee || !factoryNames.has(content.slice(callee.from, callee.to))) return;
    targetNames.forEach((name) => receivers.add(name));
  });
  return receivers;
}

function pythonSymbol(node, content, relativePath) {
  const name = syntaxTreeChildren(node).find((child) => child.name === "VariableName");
  if (!name) return null;
  if (node.name === "ClassDefinition") {
    const body = syntaxTreeChildren(node).find((child) => child.name === "Body");
    const methods = body
      ? syntaxTreeChildren(body)
        .filter((child) => child.name === "FunctionDefinition")
        .map((child) => syntaxTreeChildren(child).find((nested) => nested.name === "VariableName"))
        .filter(Boolean)
        .map((child) => content.slice(child.from, child.to))
      : [];
    return { type: "class", name: content.slice(name.from, name.to), methods, evidence: pythonEvidence(content, node, relativePath) };
  }
  if (node.name === "FunctionDefinition") return { type: "function", name: content.slice(name.from, name.to), methods: [], evidence: pythonEvidence(content, node, relativePath) };
  return null;
}

function pythonNamedImportReferences(node, content) {
  const tokens = syntaxTreeChildren(node).map((child) => ({ name: child.name, text: content.slice(child.from, child.to) }));
  if (tokens[0]?.name !== "from") return new Map();
  let module = "";
  let importIndex = -1;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index].name === "import") {
      importIndex = index;
      break;
    }
    module += tokens[index].text;
  }
  if (!module || importIndex < 0) return new Map();
  const bindings = new Map();
  let pendingName = null;
  let readingAlias = false;
  const finish = () => {
    if (pendingName) bindings.set(pendingName, { specifier: module, exportedName: pendingName });
    pendingName = null;
    readingAlias = false;
  };
  for (const token of tokens.slice(importIndex + 1)) {
    if (token.name === ",") {
      finish();
      continue;
    }
    if (token.name === "as") {
      readingAlias = true;
      continue;
    }
    if (token.name !== "VariableName") continue;
    if (readingAlias && pendingName) {
      bindings.set(token.text, { specifier: module, exportedName: pendingName });
      pendingName = null;
      readingAlias = false;
    } else {
      finish();
      pendingName = token.text;
    }
  }
  finish();
  return bindings;
}

function pythonModuleImportReferences(node, content) {
  const tokens = syntaxTreeChildren(node).map((child) => ({ name: child.name, text: content.slice(child.from, child.to) }));
  if (tokens[0]?.name !== "import") return new Map();
  const bindings = new Map();
  let specifier = "";
  let alias = null;
  let readingAlias = false;
  const finish = () => {
    if (specifier) bindings.set(alias || specifier.split(".")[0], specifier);
    specifier = "";
    alias = null;
    readingAlias = false;
  };
  for (const token of tokens.slice(1)) {
    if (token.name === ",") {
      finish();
      continue;
    }
    if (token.name === "as") {
      readingAlias = true;
      continue;
    }
    if (readingAlias && token.name === "VariableName") alias = token.text;
    else if (!readingAlias) specifier += token.text;
  }
  finish();
  return bindings;
}

function pythonDeclarationName(node, content) {
  const name = syntaxTreeChildren(node).find((child) => child.name === "VariableName");
  return name ? content.slice(name.from, name.to) : null;
}

function pythonIsTopLevelDeclaration(node, root) {
  const isRoot = (candidate) => candidate && candidate.name === root.name && candidate.from === root.from && candidate.to === root.to;
  return isRoot(node.parent) || (node.parent?.name === "DecoratedStatement" && isRoot(node.parent.parent));
}

function pythonEnclosingTopLevelSymbol(node, root, content) {
  for (let current = node.parent; current && current !== root; current = current.parent) {
    if (!pythonIsTopLevelDeclaration(current, root)) continue;
    if (current.name === "FunctionDefinition") return { type: "function", name: pythonDeclarationName(current, content) };
    if (current.name === "ClassDefinition") return { type: "class", name: pythonDeclarationName(current, content) };
  }
  return null;
}

function pythonBoundNames(functionNode, content) {
  const names = new Set();
  const parameterList = syntaxTreeChildren(functionNode).find((child) => child.name === "ParamList");
  for (const parameter of parameterList ? syntaxTreeChildren(parameterList) : []) {
    if (parameter.name === "VariableName") names.add(content.slice(parameter.from, parameter.to));
  }
  const body = syntaxTreeChildren(functionNode).find((child) => child.name === "Body");
  const visit = (node) => {
    if (node !== body && node.name === "FunctionDefinition") {
      const name = pythonDeclarationName(node, content);
      if (name) names.add(name);
      return;
    }
    const children = syntaxTreeChildren(node);
    if (node.name === "AssignStatement") {
      for (const child of children) {
        if (child.name === "AssignOp") break;
        if (child.name === "VariableName") names.add(content.slice(child.from, child.to));
      }
    }
    if (node.name === "ForStatement") {
      for (const child of children) {
        if (child.name === "in") break;
        if (child.name === "VariableName") names.add(content.slice(child.from, child.to));
      }
    }
    for (const child of children) visit(child);
  };
  if (body) visit(body);
  return names;
}

function pythonCallNameIsShadowed(node, name, content, bindingCache) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.name !== "FunctionDefinition") continue;
    if (!bindingCache.has(current)) bindingCache.set(current, pythonBoundNames(current, content));
    return bindingCache.get(current).has(name);
  }
  return false;
}

function pythonDjangoManagementCommandFacts(root, content, relativePath, importedBindings) {
  const segments = toPosix(relativePath).split("/");
  const filename = segments.at(-1) || "";
  if (segments.length < 3 || segments.at(-3) !== "management" || segments.at(-2) !== "commands" || !filename.endsWith(".py")) {
    return { commands: [], unsupported: [] };
  }
  const commandName = filename.slice(0, -3);
  if (!commandName || commandName.startsWith("_")) {
    return { commands: [], unsupported: [{ path: relativePath, commandName, reason: "private-or-initializer-command-module" }] };
  }
  const declarations = syntaxTreeChildren(root)
    .map((statement) => statement.name === "DecoratedStatement"
      ? syntaxTreeChildren(statement).find((child) => child.name === "ClassDefinition")
      : statement)
    .filter((statement) => statement?.name === "ClassDefinition" && pythonDeclarationName(statement, content) === "Command");
  if (declarations.length !== 1) {
    return { commands: [], unsupported: [{ path: relativePath, commandName, reason: declarations.length ? "ambiguous-command-class" : "missing-top-level-command-class" }] };
  }
  const declaration = declarations[0];
  const argumentList = syntaxTreeChildren(declaration).find((child) => child.name === "ArgList");
  const baseNames = (argumentList ? syntaxTreeChildren(argumentList) : [])
    .filter((child) => child.name === "VariableName")
    .map((child) => content.slice(child.from, child.to));
  const exactBase = baseNames.find((baseName) => {
    const binding = importedBindings.get(baseName);
    return binding?.specifier === "django.core.management.base" && binding?.exportedName === "BaseCommand";
  });
  if (!exactBase) {
    return { commands: [], unsupported: [{ path: relativePath, commandName, reason: "command-class-does-not-directly-extend-imported-base-command" }] };
  }
  const body = syntaxTreeChildren(declaration).find((child) => child.name === "Body");
  const handleMethods = (body ? syntaxTreeChildren(body) : [])
    .filter((child) => child.name === "FunctionDefinition" && pythonDeclarationName(child, content) === "handle");
  if (handleMethods.length !== 1) {
    return { commands: [], unsupported: [{ path: relativePath, commandName, reason: handleMethods.length ? "ambiguous-direct-handle-method" : "missing-direct-handle-method" }] };
  }
  return {
    commands: [{
      adapter: "django",
      commandName,
      targetName: "Command",
      targetType: "class",
      path: relativePath,
      evidence: pythonEvidence(content, declaration, relativePath),
    }],
    unsupported: [],
  };
}

function pythonCallParts(node, content) {
  const callee = syntaxTreeChildren(node).find((child) => ["VariableName", "MemberExpression"].includes(child.name));
  if (!callee) return [];
  if (callee.name === "VariableName") return [content.slice(callee.from, callee.to)];
  return syntaxTreeChildren(callee)
    .filter((child) => ["VariableName", "PropertyName"].includes(child.name))
    .map((child) => content.slice(child.from, child.to));
}

function pythonFrameworkFactoryReceivers(root, content, moduleBindings, importedBindings) {
  const typerReceivers = new Set();
  const flaskReceivers = new Set();
  for (const statement of syntaxTreeChildren(root)) {
    if (statement.name !== "AssignStatement") continue;
    const children = syntaxTreeChildren(statement);
    const assignmentIndex = children.findIndex((child) => child.name === "AssignOp");
    const target = assignmentIndex === 1 && children[0]?.name === "VariableName" ? content.slice(children[0].from, children[0].to) : null;
    const call = assignmentIndex >= 0 && children.slice(assignmentIndex + 1).find((child) => child.name === "CallExpression");
    if (!target || !call) continue;
    const parts = pythonCallParts(call, content);
    if (parts.length === 2 && moduleBindings.get(parts[0]) === "typer" && parts[1] === "Typer") typerReceivers.add(target);
    if (parts.length === 1) {
      const binding = importedBindings.get(parts[0]);
      if (binding?.specifier === "flask" && binding.exportedName === "Flask") flaskReceivers.add(target);
    }
  }
  return { typerReceivers, flaskReceivers };
}

function pythonCommandDecoratorName(decorator, content) {
  const argumentList = syntaxTreeChildren(decorator).find((child) => child.name === "ArgList");
  if (!argumentList) return { status: "unsupported", reason: "missing-command-decorator-call" };
  const arguments_ = syntaxTreeChildren(argumentList).filter((child) => !["(", ")", ","].includes(child.name));
  if (!arguments_.length) return { status: "default" };
  if (arguments_.length === 1 && arguments_[0].name === "String") {
    const commandName = pythonStringLiteral(content, arguments_[0]);
    if (commandName) return { status: "literal", commandName };
  }
  return { status: "unsupported", reason: "non-literal-or-unsupported-command-name" };
}

function pythonDecoratorFrameworkCommandFacts(root, content, relativePath, moduleBindings, importedBindings) {
  const commands = [];
  const unsupported = [];
  const { typerReceivers, flaskReceivers } = pythonFrameworkFactoryReceivers(root, content, moduleBindings, importedBindings);
  for (const statement of syntaxTreeChildren(root)) {
    if (statement.name !== "DecoratedStatement") continue;
    const functionNode = syntaxTreeChildren(statement).find((child) => child.name === "FunctionDefinition");
    const targetName = functionNode && pythonDeclarationName(functionNode, content);
    if (!targetName) continue;
    for (const decorator of syntaxTreeChildren(statement).filter((child) => child.name === "Decorator")) {
      const parts = syntaxTreeChildren(decorator)
        .filter((child) => ["VariableName", "PropertyName"].includes(child.name))
        .map((child) => content.slice(child.from, child.to));
      const adapter = parts.length === 2 && moduleBindings.get(parts[0]) === "click" && parts[1] === "command"
        ? "click"
        : parts.length === 2 && typerReceivers.has(parts[0]) && parts[1] === "command"
          ? "typer"
          : parts.length === 3 && flaskReceivers.has(parts[0]) && parts[1] === "cli" && parts[2] === "command"
            ? "flask"
            : null;
      if (!adapter) continue;
      const declaration = pythonCommandDecoratorName(decorator, content);
      if (declaration.status === "unsupported") {
        unsupported.push({ path: relativePath, adapter, targetName, reason: declaration.reason });
        continue;
      }
      commands.push({
        adapter,
        commandName: declaration.commandName || targetName,
        targetName,
        targetType: "function",
        path: relativePath,
        evidence: pythonEvidence(content, decorator, relativePath),
      });
    }
  }
  return { commands, unsupported };
}

function analyzePython(content, relativePath) {
  try {
    const tree = getPythonParser().parse(content);
    const imports = [];
    const endpoints = [];
    const calls = [];
    const methods = [];
    const symbols = [];
    const importedBindings = new Map();
    const moduleBindings = new Map();
    const bindingCache = new Map();
    let diagnostics = 0;
    visitSyntaxTree(tree.topNode, (node) => {
      if (node.name !== "ImportStatement") return;
      for (const specifier of pythonImportFacts(node, content)) imports.push({ specifier, language: "python", evidence: pythonEvidence(content, node, relativePath) });
      for (const [name, binding] of pythonNamedImportReferences(node, content)) importedBindings.set(name, binding);
      for (const [name, specifier] of pythonModuleImportReferences(node, content)) moduleBindings.set(name, specifier);
    });
    const routeReceivers = pythonFlaskRouteReceivers(tree.topNode, content, pythonFlaskFactoryNames(importedBindings));
    visitSyntaxTree(tree.topNode, (node) => {
      if (node.name === "⚠") diagnostics += 1;
      if (node.name === "CallExpression") {
        const callee = syntaxTreeChildren(node).find((child) => child.name === "VariableName");
        const name = callee && content.slice(callee.from, callee.to);
        if (name && !pythonCallNameIsShadowed(node, name, content, bindingCache)) {
          calls.push({ name, source: pythonEnclosingTopLevelSymbol(node, tree.topNode, content), imported: importedBindings.get(name) || null, evidence: pythonEvidence(content, node, relativePath) });
        }
      }
      if (node.name === "FunctionDefinition") {
        const name = syntaxTreeChildren(node).find((child) => child.name === "VariableName");
        if (name) methods.push(content.slice(name.from, name.to));
      }
      if (node.name === "DecoratedStatement") {
        for (const decorator of syntaxTreeChildren(node).filter((child) => child.name === "Decorator")) {
          endpoints.push(...pythonDecoratorEndpoints(decorator, content, relativePath, routeReceivers));
        }
      }
    });
    for (const statement of syntaxTreeChildren(tree.topNode)) {
      const declaration = statement.name === "DecoratedStatement"
        ? syntaxTreeChildren(statement).find((child) => ["ClassDefinition", "FunctionDefinition"].includes(child.name))
        : statement;
      const symbol = declaration && pythonSymbol(declaration, content, relativePath);
      if (symbol) symbols.push(symbol);
    }
    const djangoFrameworkCommandFacts = pythonDjangoManagementCommandFacts(tree.topNode, content, relativePath, importedBindings);
    const decoratorFrameworkCommandFacts = pythonDecoratorFrameworkCommandFacts(tree.topNode, content, relativePath, moduleBindings, importedBindings);
    return {
      imports,
      endpoints,
      requests: [],
      calls,
      methods: [...new Set(methods)].slice(0, 12),
      symbols,
      frameworkCommands: [...djangoFrameworkCommandFacts.commands, ...decoratorFrameworkCommandFacts.commands],
      unsupportedFrameworkCommands: [...djangoFrameworkCommandFacts.unsupported, ...decoratorFrameworkCommandFacts.unsupported],
      analysis: { parser: "python-lezer", status: diagnostics ? "parsed-with-diagnostics" : "parsed", confidence: "exact", diagnostics },
    };
  } catch (error) {
    return { imports: [], endpoints: [], requests: [], calls: [], methods: [], symbols: [], frameworkCommands: [], unsupportedFrameworkCommands: [], analysis: { parser: "python-lezer", status: "parse-failed", confidence: "not-analyzed", reason: error.message } };
  }
}

function positionFromOffset(content, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return { line, column };
}

function svelteCompiler(root) {
  try {
    const targetCompiler = createRequire(path.join(root, "package.json"))("svelte/compiler");
    if (targetCompiler?.parse) return targetCompiler;
  } catch {}
  try {
    return require("svelte/compiler");
  } catch {
    return null;
  }
}

function analyzeSvelte(content, relativePath, root) {
  const compiler = svelteCompiler(root);
  if (!compiler?.parse) return analyzeInventory(relativePath, ".svelte");
  try {
    const ast = compiler.parse(content);
    const imports = [];
    const visited = new WeakSet();
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (visited.has(value)) return;
      visited.add(value);
      if (value.type === "ImportDeclaration" && typeof value.source?.value === "string") {
        const start = typeof value.start === "number" ? value.start : 0;
        const end = typeof value.end === "number" ? value.end : start;
        imports.push({ specifier: value.source.value, evidence: { parser: "svelte-compiler", file: relativePath, range: { start: positionFromOffset(content, start), end: positionFromOffset(content, end) } } });
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    };
    visit(ast.module);
    visit(ast.instance);
    return { imports, endpoints: [], requests: [], calls: [], methods: [], symbols: [], analysis: { parser: "svelte-compiler", status: "parsed", confidence: "exact", diagnostics: 0 } };
  } catch (error) {
    return { imports: [], endpoints: [], requests: [], calls: [], methods: [], symbols: [], analysis: { parser: "svelte-compiler", status: "parse-failed", confidence: "not-analyzed", reason: error.message } };
  }
}

function analyzeFile(content, extension, relativePath, root, goFact = null) {
  if (JS_TS_EXTENSIONS.has(extension)) return analyzeJavaScriptTypeScript(content, extension, relativePath, frameworkRoute(relativePath));
  if (extension === ".svelte") return analyzeSvelte(content, relativePath, root);
  if (extension === ".py") return analyzePython(content, relativePath);
  if (extension === ".php") return analyzePhp(content, relativePath);
  if (extension === ".java") return analyzeJava(content, relativePath);
  if (extension === ".rs") return analyzeRust(content, relativePath);
  if (extension === ".go") return analyzeGoFact(goFact, relativePath);
  if (extension === ".cs") return analyzeCSharpFact(goFact, relativePath);
  return analyzeInventory(relativePath, extension);
}

function summarizeFileCoverage(records) {
  const summary = { scannedFiles: 0, parsedFiles: 0, parsedWithDiagnosticsFiles: 0, inventoryOnlyFiles: 0, parseFailedFiles: 0 };
  const byLanguage = new Map();
  for (const record of records) {
    // Prepared parser facts deliberately have no assembled file node. Keep
    // coverage independent from graph topology so the native envelope can be
    // constructed before JavaScript graph assembly.
    const language = record.node?.language || record.language || "unknown";
    if (!byLanguage.has(language)) byLanguage.set(language, { language, files: 0, parsed: 0, parsedWithDiagnostics: 0, inventoryOnly: 0, parseFailed: 0, parsers: new Set() });
    const languageSummary = byLanguage.get(language);
    const status = record.result.analysis.status;
    summary.scannedFiles += 1;
    languageSummary.files += 1;
    languageSummary.parsers.add(record.result.analysis.parser);
    if (status.startsWith("parsed")) {
      summary.parsedFiles += 1;
      languageSummary.parsed += 1;
    }
    if (status === "parsed-with-diagnostics") {
      summary.parsedWithDiagnosticsFiles += 1;
      languageSummary.parsedWithDiagnostics += 1;
    }
    if (status === "inventory-only") {
      summary.inventoryOnlyFiles += 1;
      languageSummary.inventoryOnly += 1;
    }
    if (status === "parse-failed") {
      summary.parseFailedFiles += 1;
      languageSummary.parseFailed += 1;
    }
  }
  return {
    summary,
    byLanguage: [...byLanguage.values()]
      .map(({ parsers, ...languageSummary }) => ({ ...languageSummary, parsers: [...parsers].sort() }))
      .sort((left, right) => left.language.localeCompare(right.language)),
    interpretation: "Coverage counts syntax-tree analysis status, not runtime execution coverage or relationship precision.",
  };
}

function resolveFile(root, base) {
  const candidates = [];
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(base + extension);
  for (const extension of RESOLVE_EXTENSIONS.slice(1)) candidates.push(path.join(base, `index${extension}`));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return toPosix(path.relative(root, candidate));
  }
  return null;
}

function pathPatternMatch(pattern, specifier) {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function resolvePythonFile(root, base) {
  const candidates = [`${base}.py`, path.join(base, "__init__.py")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return toPosix(path.relative(root, candidate));
  }
  return null;
}

function resolvePythonImport(root, fromFile, specifier) {
  if (specifier.startsWith(".")) {
    let dots = 0;
    while (specifier[dots] === ".") dots += 1;
    let base = path.dirname(fromFile);
    for (let index = 1; index < dots; index += 1) base = path.dirname(base);
    const segments = specifier.slice(dots).split(".").filter(Boolean);
    return resolvePythonFile(root, path.join(base, ...segments));
  }
  const segments = specifier.split(".").filter(Boolean);
  for (const sourceRoot of [root, path.join(root, "src")]) {
    const resolved = resolvePythonFile(root, path.join(sourceRoot, ...segments));
    if (resolved) return resolved;
  }
  return null;
}

function nearestCargoPackageDirectory(root, fromFile) {
  for (let directory = path.dirname(fromFile); ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "Cargo.toml");
    if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) return directory;
    if (directory === root || path.dirname(directory) === directory) return null;
  }
}

function rustSourceRoot(packageDirectory) {
  const source = path.join(packageDirectory, "src");
  return fs.existsSync(source) && fs.statSync(source).isDirectory() ? source : null;
}

function rustModulePath(sourceRoot, fromFile) {
  const relative = path.relative(sourceRoot, fromFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return [];
  const segments = toPosix(relative).split("/");
  const filename = segments.pop();
  if (!filename) return [];
  if (filename === "lib.rs" || filename === "main.rs" || filename === "mod.rs") return segments;
  if (segments.length === 1 && segments[0] === "bin" && filename.endsWith(".rs")) return [];
  return [...segments, filename.endsWith(".rs") ? filename.slice(0, -3) : filename];
}

function resolveRustModuleFile(root, sourceRoot, segments) {
  for (let length = segments.length; length > 0; length -= 1) {
    const base = path.join(sourceRoot, ...segments.slice(0, length));
    for (const candidate of [`${base}.rs`, path.join(base, "mod.rs")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return toPosix(path.relative(root, candidate));
    }
  }
  return null;
}

function resolveRustImport(root, fromFile, specifier) {
  const segments = specifier.split("::").filter((segment) => segment && segment !== "*");
  if (!segments.length || !["crate", "self", "super"].includes(segments[0])) return null;
  const packageDirectory = nearestCargoPackageDirectory(root, fromFile);
  const sourceRoot = packageDirectory && rustSourceRoot(packageDirectory);
  if (!sourceRoot) return null;
  let targetSegments;
  if (segments[0] === "crate") targetSegments = segments.slice(1);
  else {
    const current = rustModulePath(sourceRoot, fromFile);
    let index = 0;
    let base = current;
    if (segments[index] === "self") index += 1;
    while (segments[index] === "super") {
      if (!base.length) return null;
      base = base.slice(0, -1);
      index += 1;
    }
    targetSegments = [...base, ...segments.slice(index)];
  }
  return resolveRustModuleFile(root, sourceRoot, targetSegments);
}

function repositoryFilesNamed(filename, directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) repositoryFilesNamed(filename, path.join(directory, entry.name), output);
      continue;
    }
    if (entry.isFile() && entry.name === filename) output.push(path.join(directory, entry.name));
  }
  return output;
}

function readGoModulePath(goModPath) {
  try {
    for (const line of fs.readFileSync(goModPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      const [keyword, modulePath] = trimmed.split(/\s+/, 2);
      if (keyword !== "module") continue;
      if (modulePath && modulePath !== "(") return modulePath.replace(/^"|"$/g, "");
    }
  } catch {
    // An unreadable module manifest is treated as unavailable configuration.
  }
  return null;
}

function createGoModuleResolver(root, sourcePaths = null) {
  const modules = repositoryFilesNamed("go.mod", root)
    .map((goModPath) => ({ modulePath: readGoModulePath(goModPath), directory: path.dirname(goModPath) }))
    .filter((entry) => entry.modulePath)
    .sort((left, right) => right.modulePath.length - left.modulePath.length || left.modulePath.localeCompare(right.modulePath));
  const packageFiles = new Map();
  const goFiles = sourcePaths
    ? sourcePaths.map((relativePath) => path.resolve(root, relativePath)).filter((candidate) => extensionOf(candidate) === ".go")
    : walk(root).filter((candidate) => extensionOf(candidate) === ".go");
  for (const absolutePath of goFiles) {
    const relativePath = toPosix(path.relative(root, absolutePath));
    if (isTestPath(relativePath)) continue;
    const directory = path.dirname(absolutePath);
    if (!packageFiles.has(directory)) packageFiles.set(directory, []);
    packageFiles.get(directory).push(absolutePath);
  }
  for (const files of packageFiles.values()) files.sort((left, right) => left.localeCompare(right));

  return (specifier) => {
    const module = modules.find((entry) => specifier === entry.modulePath || specifier.startsWith(`${entry.modulePath}/`));
    if (!module) return null;
    const subpath = specifier.slice(module.modulePath.length).replace(/^\/+/, "");
    const candidates = packageFiles.get(path.join(module.directory, subpath)) || [];
    if (candidates.length === 1) return toPosix(path.relative(root, candidates[0]));
    if (candidates.length > 1) {
      return {
        kind: "go-package",
        path: toPosix(path.relative(root, path.join(module.directory, subpath))) || ".",
        files: candidates.map((candidate) => toPosix(path.relative(root, candidate))),
      };
    }
    return null;
  };
}

function parseProjectConfig(configPath) {
  const file = ts.readConfigFile(configPath, ts.sys.readFile);
  if (file.error) return null;
  const parsed = ts.parseJsonConfigFileContent(file.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const paths = Object.entries(parsed.options.paths || {})
    .filter(([, targets]) => Array.isArray(targets) && targets.every((target) => typeof target === "string"))
    .sort(([left], [right]) => right.replace("*", "").length - left.replace("*", "").length || left.localeCompare(right));
  if (!paths.length && !parsed.options.baseUrl) return null;
  return { baseUrl: parsed.options.baseUrl || path.dirname(configPath), paths };
}

function createConfiguredResolver(root) {
  const configCache = new Map();
  const resolutionCache = new WeakMap();
  const findConfig = (fromFile) => {
    for (let directory = path.dirname(fromFile); ; directory = path.dirname(directory)) {
      if (!configCache.has(directory)) {
        const configPath = ["tsconfig.json", "jsconfig.json"]
          .map((filename) => path.join(directory, filename))
          .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        configCache.set(directory, configPath ? parseProjectConfig(configPath) : null);
      }
      const config = configCache.get(directory);
      if (config) return config;
      if (directory === root || path.dirname(directory) === directory) return null;
    }
  };

  return (fromFile, specifier) => {
    const config = findConfig(fromFile);
    if (!config) return null;
    let cached = resolutionCache.get(config);
    if (!cached) {
      cached = new Map();
      resolutionCache.set(config, cached);
    }
    // Once findConfig selected one config, path-pattern and baseUrl resolution
    // depend only on that immutable config plus the specifier. Reusing misses
    // is particularly important for repeated third-party imports: it avoids
    // probing the same local baseUrl candidates for every importing file.
    if (cached.has(specifier)) return cached.get(specifier);
    for (const [pattern, targets] of config.paths) {
      const wildcardValue = pathPatternMatch(pattern, specifier);
      if (wildcardValue === null) continue;
      for (const target of targets) {
        const resolved = resolveFile(root, path.resolve(config.baseUrl, target.replaceAll("*", wildcardValue)));
        if (resolved) {
          cached.set(specifier, resolved);
          return resolved;
        }
      }
    }
    const resolved = resolveFile(root, path.resolve(config.baseUrl, specifier));
    cached.set(specifier, resolved || null);
    return resolved;
  };
}

function propertyName(property) {
  if (!ts.isPropertyAssignment(property)) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) return property.name.text;
  return null;
}

function objectProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return null;
  return object.properties.find((property) => propertyName(property) === name)?.initializer || null;
}

function literalConfigString(node) {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function staticBundlerExpressionResolver(source, configPath, root) {
  const configDirectory = path.dirname(configPath);
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolving = new Set();
  const importMetaUrl = (node) => ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.name) && node.name.text === "url"
    && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  const pathCall = (node) => {
    if (!ts.isCallExpression(node)) return null;
    const expression = node.expression;
    if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "path") return null;
    if (!["resolve", "join", "dirname"].includes(expression.name.text)) return null;
    const values = node.arguments.map(evaluate);
    if (values.some((value) => value === null)) return null;
    if (expression.name.text === "dirname") return values.length === 1 ? path.dirname(values[0]) : null;
    return expression.name.text === "resolve" ? path.resolve(...values) : path.join(...values);
  };
  const evaluate = (node) => {
    if (!node) return null;
    const literal = literalConfigString(node);
    if (literal !== null) return literal;
    if (ts.isIdentifier(node)) {
      if (node.text === "__dirname") return configDirectory;
      if (!bindings.has(node.text) || resolving.has(node.text)) return null;
      resolving.add(node.text);
      const value = evaluate(bindings.get(node.text));
      resolving.delete(node.text);
      return value;
    }
    const resolvedPath = pathCall(node);
    if (resolvedPath !== null) return resolvedPath;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.length === 2 && importMetaUrl(node.arguments[1])) {
      const relative = evaluate(node.arguments[0]);
      return relative === null ? null : path.resolve(configDirectory, relative);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process" && node.expression.name.text === "cwd" && node.arguments.length === 0) return configDirectory === root ? root : null;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fileURLToPath" && node.arguments.length === 1) return importMetaUrl(node.arguments[0]) ? configPath : evaluate(node.arguments[0]);
    return null;
  };
  return { evaluate, bindings };
}

function scriptKindFor(filePath) {
  const extension = extensionOf(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function parseBundlerAliasEntries(alias, configDirectory, evaluate) {
  const entries = [];
  const add = (find, replacement) => {
    if (find && replacement) entries.push({ find, replacement, configDirectory });
  };
  if (ts.isObjectLiteralExpression(alias)) {
    for (const property of alias.properties) add(propertyName(property), ts.isPropertyAssignment(property) ? evaluate(property.initializer) : null);
  }
  if (ts.isArrayLiteralExpression(alias)) {
    for (const item of alias.elements) {
      if (!ts.isObjectLiteralExpression(item)) continue;
      add(evaluate(objectProperty(item, "find")), evaluate(objectProperty(item, "replacement")));
    }
  }
  return entries;
}

function unwrapBundlerConfigExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
  return current;
}

function isModuleExports(node) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "module"
    && node.name.text === "exports";
}

function exportedBundlerConfigObjects(source, bindings) {
  const resolving = new Set();
  const fromExpression = (expression) => {
    const node = unwrapBundlerConfigExpression(expression);
    if (!node) return [];
    if (ts.isObjectLiteralExpression(node)) return [node];
    if (ts.isIdentifier(node) && bindings.has(node.text) && !resolving.has(node.text)) {
      resolving.add(node.text);
      const objects = fromExpression(bindings.get(node.text));
      resolving.delete(node.text);
      return objects;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineConfig" && node.arguments.length >= 1) return fromExpression(node.arguments[0]);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const body = unwrapBundlerConfigExpression(node.body);
      if (ts.isObjectLiteralExpression(body)) return [body];
      if (ts.isBlock(body)) return body.statements.flatMap((statement) => ts.isReturnStatement(statement) && statement.expression ? fromExpression(statement.expression) : []);
    }
    return [];
  };
  return source.statements.flatMap((statement) => {
    if (ts.isExportAssignment(statement)) return fromExpression(statement.expression);
    const expression = ts.isExpressionStatement(statement) ? statement.expression : null;
    if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExports(expression.left)) return fromExpression(expression.right);
    return [];
  });
}

function parseBundlerConfig(configPath, root) {
  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const source = ts.createSourceFile(configPath, content, ts.ScriptTarget.Latest, false, scriptKindFor(configPath));
  const { evaluate, bindings } = staticBundlerExpressionResolver(source, configPath, root);
  const aliases = [];
  for (const object of exportedBundlerConfigObjects(source, bindings)) {
    const resolve = objectProperty(object, "resolve");
    const alias = resolve && objectProperty(resolve, "alias");
    if (alias) aliases.push(...parseBundlerAliasEntries(alias, path.dirname(configPath), evaluate));
  }
  return aliases;
}

function createBundlerAliasResolver(root) {
  const aliasCache = new Map();
  const aliasesAt = (directory) => {
    if (!aliasCache.has(directory)) {
      const aliases = BUNDLER_CONFIG_FILENAMES
        .map((filename) => path.join(directory, filename))
        .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
        .flatMap((configPath) => parseBundlerConfig(configPath, root))
        .sort((left, right) => right.find.length - left.find.length || left.find.localeCompare(right.find));
      aliasCache.set(directory, aliases);
    }
    return aliasCache.get(directory);
  };

  const findAliases = (fromFile) => {
    for (let directory = path.dirname(fromFile); ; directory = path.dirname(directory)) {
      const aliases = aliasesAt(directory);
      if (aliases.length) return aliases;
      if (directory === root || path.dirname(directory) === directory) return [];
    }
  };

  return (fromFile, specifier) => {
    for (const alias of findAliases(fromFile)) {
      if (specifier !== alias.find && !specifier.startsWith(`${alias.find}/`)) continue;
      const suffix = specifier.slice(alias.find.length).replace(/^[\\/]+/, "");
      const replacement = path.isAbsolute(alias.replacement) ? alias.replacement : path.resolve(alias.configDirectory, alias.replacement);
      const resolved = resolveFile(root, path.join(replacement, suffix));
      if (resolved) return resolved;
    }
    return null;
  };
}

function getGitChangedPaths(root, base = null) {
  const command = (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return null;
    }
  };
  const working = command(["diff", "--name-only", "--diff-filter=ACMR", ...(base ? [base] : [])]);
  const staged = base ? [] : command(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  const untracked = command(["ls-files", "--others", "--exclude-standard"]);
  if (!working || !staged || !untracked) throw new Error("Unable to read changed files from Git. Supply --changed with repository-relative paths instead.");
  return [...new Set([...working, ...staged, ...untracked].map(toPosix))].sort();
}

function stripYamlComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === "\"") quote = character;
    else if (character === "#") return value.slice(0, index);
  }
  return value;
}

function yamlWorkspacePattern(value) {
  let pattern = stripYamlComment(value).trim();
  if ((pattern.startsWith("\"") && pattern.endsWith("\"")) || (pattern.startsWith("'") && pattern.endsWith("'"))) pattern = pattern.slice(1, -1);
  return pattern || null;
}

function yamlInlineWorkspacePatterns(value) {
  const source = stripYamlComment(value).trim();
  if (!source.startsWith("[") || !source.endsWith("]")) return null;
  const patterns = [];
  let current = "";
  let quote = null;
  for (const character of source.slice(1, -1)) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      const pattern = yamlWorkspacePattern(current);
      if (pattern) patterns.push(pattern);
      current = "";
      continue;
    }
    current += character;
  }
  const pattern = yamlWorkspacePattern(current);
  if (pattern) patterns.push(pattern);
  return patterns;
}

function pnpmWorkspacePatterns(root) {
  let content;
  try {
    content = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const patterns = [];
  let readingPackages = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!readingPackages) {
      const match = trimmed.match(/^packages\s*:\s*(.*)$/);
      if (!match) continue;
      const inlinePatterns = yamlInlineWorkspacePatterns(match[1]);
      if (inlinePatterns) patterns.push(...inlinePatterns);
      else if (!stripYamlComment(match[1]).trim()) readingPackages = true;
      continue;
    }
    if (!/^\s/.test(line) && /^[\w-]+\s*:/.test(trimmed)) break;
    const item = trimmed.match(/^-\s+(.+?)\s*$/);
    if (!item) continue;
    const pattern = yamlWorkspacePattern(item[1]);
    if (pattern) patterns.push(pattern);
  }
  return patterns;
}

function workspacePatterns(root, packageJson) {
  const packageJsonPatterns = Array.isArray(packageJson.workspaces)
    ? packageJson.workspaces
    : Array.isArray(packageJson.workspaces?.packages)
      ? packageJson.workspaces.packages
      : [];
  return [...new Set([...packageJsonPatterns, ...pnpmWorkspacePatterns(root)])];
}

function workspaceSegmentMatches(pattern, value) {
  const parts = pattern.split("*");
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const found = value.indexOf(part, offset);
    if (found < 0 || (index === 0 && !pattern.startsWith("*") && found !== 0)) return false;
    offset = found + part.length;
  }
  const last = parts.at(-1);
  return pattern.endsWith("*") || !last || value.endsWith(last);
}

function workspacePathMatches(pattern, relativePath) {
  const patternSegments = toPosix(pattern).split("/").filter(Boolean);
  const pathSegments = toPosix(relativePath).split("/").filter(Boolean);
  const matches = (patternIndex, pathIndex) => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const patternSegment = patternSegments[patternIndex];
    if (patternSegment === "**") {
      for (let index = pathIndex; index <= pathSegments.length; index += 1) if (matches(patternIndex + 1, index)) return true;
      return false;
    }
    return pathIndex < pathSegments.length && workspaceSegmentMatches(patternSegment, pathSegments[pathIndex]) && matches(patternIndex + 1, pathIndex + 1);
  };
  return matches(0, 0);
}

function workspaceDirectories(root, patterns) {
  const matches = new Set();
  const visit = (directory, segments, index) => {
    if (index === segments.length) {
      if (fs.existsSync(path.join(directory, "package.json"))) matches.add(directory);
      return;
    }
    const segment = segments[index];
    if (!segment || segment === "." || segment === "..") return;
    if (segment === "**") {
      visit(directory, segments, index + 1);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name), segments, index);
      }
      return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name) || !workspaceSegmentMatches(segment, entry.name)) continue;
      visit(path.join(directory, entry.name), segments, index + 1);
    }
  };
  const positivePatterns = patterns.filter((value) => typeof value === "string" && value && !value.startsWith("!"));
  const exclusions = patterns.filter((value) => typeof value === "string" && value.startsWith("!")).map((value) => value.slice(1));
  for (const pattern of positivePatterns) {
    const segments = toPosix(pattern).split("/").filter(Boolean);
    if (segments.length) visit(root, segments, 0);
  }
  return [...matches].filter((directory) => !exclusions.some((pattern) => workspacePathMatches(pattern, toPosix(path.relative(root, directory)))));
}

const STATIC_EXPORT_CONDITIONS = ["import", "node", "default", "require", "types"];

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (!value || typeof value !== "object") return [];
  const condition = STATIC_EXPORT_CONDITIONS.find((key) => Object.hasOwn(value, key));
  return condition ? exportTargets(value[condition]) : [];
}

function isRootExportConditionMap(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => !key.startsWith("."));
}

function workspaceTargets(packageJson, subpath) {
  const exportsField = packageJson.exports;
  if (exportsField) {
    if (!subpath && (typeof exportsField === "string" || Array.isArray(exportsField))) return exportTargets(exportsField);
    if (typeof exportsField === "object") {
      const key = subpath ? `./${subpath}` : ".";
      if (Object.hasOwn(exportsField, key)) return exportTargets(exportsField[key]);
      if (!subpath && isRootExportConditionMap(exportsField)) return exportTargets(exportsField);
      const wildcardKey = Object.keys(exportsField)
        .filter((candidate) => candidate.includes("*"))
        .sort((left, right) => right.replace("*", "").length - left.replace("*", "").length || left.localeCompare(right))
        .find((candidate) => pathPatternMatch(candidate, key) !== null);
      if (wildcardKey) {
        const wildcardValue = pathPatternMatch(wildcardKey, key);
        return exportTargets(exportsField[wildcardKey]).map((target) => target.replaceAll("*", wildcardValue));
      }
    }
  }
  if (subpath) return [`./${subpath}`, `./src/${subpath}`];
  return [packageJson.module, packageJson.main, packageJson.source, packageJson.types, "./src/index", "./index"].filter(Boolean);
}

function resolveWorkspaceTarget(root, workspaceRoot, target) {
  if (typeof target !== "string" || !target.startsWith(".")) return null;
  const base = path.resolve(workspaceRoot, target);
  for (const candidate of [base, removeExtension(base)]) {
    const resolved = resolveFile(root, candidate);
    if (resolved) return resolved;
  }
  return null;
}

function createWorkspaceResolver(root, packageJson) {
  const packages = new Map();
  for (const directory of workspaceDirectories(root, workspacePatterns(root, packageJson))) {
    const manifest = safelyReadJson(path.join(directory, "package.json"), {});
    if (typeof manifest.name === "string" && manifest.name) packages.set(manifest.name, { directory, manifest });
  }
  return (specifier) => {
    const name = packageName(specifier);
    const workspace = packages.get(name);
    if (!workspace) return null;
    const subpath = specifier.slice(name.length).replace(/^\/+/, "");
    for (const target of workspaceTargets(workspace.manifest, subpath)) {
      const resolved = resolveWorkspaceTarget(root, workspace.directory, target);
      if (resolved) return resolved;
    }
    return null;
  };
}

function createYarnPnpResolver(root) {
  const data = safelyReadJson(path.join(root, ".pnp.data.json"), null);
  const packages = new Map();
  if (!Array.isArray(data?.packageRegistryData)) return () => null;
  for (const entry of data.packageRegistryData) {
    const [name, references] = Array.isArray(entry) ? entry : [];
    if (typeof name !== "string" || !Array.isArray(references)) continue;
    for (const reference of references) {
      const [, info] = Array.isArray(reference) ? reference : [];
      if (typeof info?.packageLocation !== "string") continue;
      const directory = path.resolve(root, info.packageLocation);
      const relative = path.relative(root, directory);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const manifest = safelyReadJson(path.join(directory, "package.json"), {});
      if (manifest.name === name) {
        packages.set(name, { directory, manifest });
        break;
      }
    }
  }
  return (specifier) => {
    const name = packageName(specifier);
    const workspace = packages.get(name);
    if (!workspace) return null;
    const subpath = specifier.slice(name.length).replace(/^\/+/, "");
    for (const target of workspaceTargets(workspace.manifest, subpath)) {
      const resolved = resolveWorkspaceTarget(root, workspace.directory, target);
      if (resolved) return resolved;
    }
    return null;
  };
}

function packageImportTargets(packageJson, specifier) {
  const importsField = packageJson.imports;
  if (!specifier.startsWith("#") || !importsField || typeof importsField !== "object" || Array.isArray(importsField)) return [];
  if (Object.hasOwn(importsField, specifier)) return exportTargets(importsField[specifier]);
  const wildcardKey = Object.keys(importsField)
    .filter((candidate) => candidate.startsWith("#") && candidate.includes("*"))
    .sort((left, right) => right.replace("*", "").length - left.replace("*", "").length || left.localeCompare(right))
    .find((candidate) => pathPatternMatch(candidate, specifier) !== null);
  if (!wildcardKey) return [];
  const wildcardValue = pathPatternMatch(wildcardKey, specifier);
  return exportTargets(importsField[wildcardKey]).map((target) => target.replaceAll("*", wildcardValue));
}

function createPackageImportsResolver(root) {
  const packageCache = new Map();
  const importsAt = (directory) => {
    if (!packageCache.has(directory)) {
      const manifestPath = path.join(directory, "package.json");
      const manifest = fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile() ? safelyReadJson(manifestPath, {}) : null;
      packageCache.set(directory, manifest?.imports && typeof manifest.imports === "object" && !Array.isArray(manifest.imports) ? { directory, manifest } : null);
    }
    return packageCache.get(directory);
  };

  const findPackageImports = (fromFile) => {
    for (let directory = path.dirname(fromFile); ; directory = path.dirname(directory)) {
      const packageImports = importsAt(directory);
      if (packageImports) return packageImports;
      if (directory === root || path.dirname(directory) === directory) return null;
    }
  };

  return (fromFile, specifier) => {
    const packageImports = findPackageImports(fromFile);
    if (!packageImports) return null;
    for (const target of packageImportTargets(packageImports.manifest, specifier)) {
      const resolved = resolveWorkspaceTarget(root, packageImports.directory, target);
      if (resolved) return resolved;
    }
    return null;
  };
}

function resolveInternalImport(root, fromFile, specifier, resolveConfiguredImport) {
  if (specifier.startsWith(".")) return resolveFile(root, path.resolve(path.dirname(fromFile), specifier));
  const configured = resolveConfiguredImport(fromFile, specifier);
  if (configured) return configured;
  if (specifier === "$lib" || specifier.startsWith("$lib/")) {
    let libraryPath = specifier.slice(4);
    while (libraryPath.startsWith("/") || libraryPath.startsWith("\\")) libraryPath = libraryPath.slice(1);
    return resolveFile(root, path.join(root, "src", "lib", libraryPath));
  }
  if (specifier.startsWith("@/")) return resolveFile(root, path.join(root, "src", specifier.slice(2)));
  return null;
}

function packageName(specifier) {
  const parts = specifier.split(/[\\/:]/);
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function includesAny(value, values) {
  return values.some((item) => value.includes(item));
}

function packageKind(specifier) {
  const name = packageName(specifier);
  if (includesAny(name, ["prisma", "typeorm", "sequelize", "mongoose", "knex", "drizzle-orm", "postgres", "mysql", "sqlite", "redis", "mongo"])) return "database";
  if (includesAny(name, ["bull", "kafka", "rabbit", "amqp", "nats", "sqs", "queue"])) return "queue";
  return "external";
}

function dependencyKind(specifier, devPackages) {
  const name = packageName(specifier);
  if (specifier.startsWith("$app/") || specifier.startsWith("$env/") || specifier === "$service-worker" || name === "svelte" || name === "@sveltejs/kit" || name.startsWith("@sveltejs/") || ["fastapi", "flask", "django"].includes(name)) return "framework";
  if (includesAny(name, ["prisma", "typeorm", "sequelize", "mongoose", "knex", "drizzle-orm", "postgres", "mysql", "sqlite", "redis", "mongo", "bull", "kafka", "rabbit", "amqp", "nats", "sqs", "queue", "stripe", "twilio", "resend"])) return "runtime";
  if (DEV_TOOL_NAMES.has(name) || name.startsWith("@eslint/") || name.startsWith("@typescript-eslint/") || devPackages.has(name)) return "devtool";
  return "package";
}

function createExternalNode(specifier, devPackages) {
  const name = packageName(specifier);
  const kind = dependencyKind(specifier, devPackages);
  const type = kind === "runtime" ? packageKind(specifier) : "external";
  const responsibility = {
    runtime: type === "database" ? "External runtime data store or ORM." : type === "queue" ? "External runtime queue or messaging system." : "External runtime integration.",
    framework: "Framework or platform virtual module.",
    devtool: "Build, linting, testing, or development dependency.",
    package: "Third-party library used by application code.",
  }[kind];
  return {
    id: `external:${name}`,
    kind: "external",
    type,
    label: titleCase(name),
    path: null,
    domain: "External",
    layer: kind,
    dependencyKind: kind,
    detectedResponsibility: responsibility,
    methods: [],
    analysis: { parser: "typescript-ast", status: "resolved-import", confidence: "exact" },
  };
}

function literalScriptTokens(value) {
  if (typeof value !== "string" || !value.trim()) return { status: "unsupported", reason: "script-is-not-a-nonempty-string", tokens: [] };
  const tokens = [];
  let current = "";
  for (const character of value.trim()) {
    if (SCRIPT_SHELL_SYNTAX.has(character)) return { status: "unsupported", reason: "shell-syntax-or-quoting", tokens: [] };
    if (character === " " || character === "\t") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  if (tokens.length !== 2) return { status: "unsupported", reason: "not-a-direct-runner-and-source-target", tokens };
  if (!DIRECT_SCRIPT_RUNNERS.has(tokens[0])) return { status: "unsupported", reason: "unsupported-direct-runner", tokens };
  if (!tokens[1] || tokens[1].startsWith("-")) return { status: "unsupported", reason: "missing-literal-source-target", tokens };
  return { status: "supported", runner: tokens[0], target: tokens[1], tokens };
}

function localPackageManifestPaths(root, records) {
  const manifests = new Set();
  for (const record of records) {
    for (let directory = path.dirname(record.absolutePath); ; directory = path.dirname(directory)) {
      const manifest = path.join(directory, "package.json");
      try {
        const stat = fs.lstatSync(manifest);
        if (stat.isFile() && !stat.isSymbolicLink()) manifests.add(manifest);
      } catch {}
      if (directory === root || path.dirname(directory) === directory) break;
    }
  }
  return [...manifests].sort((left, right) => left.localeCompare(right));
}

function packageScriptEntries(root, records, byRelativePath, descriptions) {
  const supported = [];
  const unsupported = [];
  const nodes = [];
  const edges = [];
  for (const manifestPath of localPackageManifestPaths(root, records)) {
    const manifest = safelyReadJson(manifestPath, null);
    const manifestRelativePath = toPosix(path.relative(root, manifestPath));
    if (!manifest || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts) || manifest.scripts === null) continue;
    for (const scriptName of Object.keys(manifest.scripts).sort((left, right) => left.localeCompare(right))) {
      const command = literalScriptTokens(manifest.scripts[scriptName]);
      if (command.status !== "supported") {
        unsupported.push({ manifest: manifestRelativePath, scriptName, reason: command.reason });
        continue;
      }
      const absoluteTarget = path.resolve(path.dirname(manifestPath), command.target);
      const relativeTarget = path.relative(root, absoluteTarget);
      if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        unsupported.push({ manifest: manifestRelativePath, scriptName, reason: "target-outside-repository" });
        continue;
      }
      const targetPath = toPosix(relativeTarget);
      const target = byRelativePath.get(targetPath);
      if (!target) {
        unsupported.push({ manifest: manifestRelativePath, scriptName, reason: "target-not-in-static-source-set", targetPath });
        continue;
      }
      const id = `command:${manifestRelativePath}:${scriptName}`;
      const evidence = {
        parser: "package-json",
        file: manifestRelativePath,
        kind: "literal-direct-runner-script",
        scriptName,
        runner: command.runner,
        targetPath,
      };
      const node = {
        id,
        kind: "command",
        type: "command",
        entryKind: "package-script",
        label: `npm run ${scriptName}`,
        path: manifestRelativePath,
        manifest: manifestRelativePath,
        scriptName,
        runner: command.runner,
        targetPath,
        domain: target.domain,
        feature: target.feature,
        // A command declaration shares the target's static source layer so
        // scope filtering cannot surface a command Flow Lens while hiding its
        // declaration from the matching Viewer/agent projection.
        layer: target.layer || "application",
        sourceScope: target.sourceScope,
        detectedResponsibility: "Literal package script declaration targeting one statically scanned source file.",
        methods: [],
        language: "json",
        analysis: { parser: "package-json", status: "literal-direct-runner", confidence: "exact" },
        evidence,
        manualDescription: descriptions[id] || "",
      };
      nodes.push(node);
      edges.push({ source: id, target: target.id, type: "declares-command-target", confidence: "exact", evidence });
      supported.push({ id, manifest: manifestRelativePath, scriptName, runner: command.runner, targetPath, targetId: target.id });
    }
  }
  return { nodes, edges, supported, unsupported };
}

function nodeCronScheduleEntries(records, findSymbol, descriptions) {
  const supported = [];
  const unsupported = [];
  const nodes = [];
  const edges = [];
  for (const record of records) {
    for (const candidate of record.result.unsupportedSchedules || []) {
      unsupported.push({ path: candidate.path || record.relativePath, reason: candidate.reason });
    }
    for (const candidate of record.result.schedules || []) {
      const target = findSymbol(record.relativePath, "function", candidate.taskName);
      if (!target) {
        unsupported.push({ path: record.relativePath, taskName: candidate.taskName, reason: "task-is-not-an-exact-local-top-level-function" });
        continue;
      }
      const start = candidate.evidence?.range?.start || { line: 0, column: 0 };
      const id = `schedule:${record.relativePath}:${candidate.taskName}:${start.line}:${start.column}`;
      const evidence = {
        ...candidate.evidence,
        kind: "node-cron-literal-schedule",
        adapter: "node-cron",
        expression: candidate.expression,
        taskName: candidate.taskName,
        targetId: target.id,
      };
      const node = {
        id,
        kind: "schedule",
        type: "schedule",
        entryKind: "node-cron-schedule",
        label: `node-cron ${candidate.expression} → ${candidate.taskName}`,
        path: record.relativePath,
        scheduleExpression: candidate.expression,
        taskName: candidate.taskName,
        targetPath: target.path,
        targetId: target.id,
        adapter: "node-cron",
        domain: record.node.domain,
        feature: record.node.feature,
        layer: record.node.layer || "application",
        sourceScope: record.node.sourceScope,
        detectedResponsibility: "Literal node-cron registration targeting one statically local top-level function.",
        methods: [],
        language: record.node.language,
        analysis: { parser: "typescript-ast", status: "literal-node-cron-schedule", confidence: "exact" },
        evidence,
        manualDescription: descriptions[id] || "",
      };
      nodes.push(node);
      edges.push({ source: id, target: target.id, type: "schedules", confidence: "exact", evidence });
      supported.push({ id, path: record.relativePath, expression: candidate.expression, taskName: candidate.taskName, targetPath: target.path, targetId: target.id });
    }
  }
  return { nodes, edges, supported, unsupported };
}

function frameworkCommandEntries(records, findSymbol, descriptions) {
  const supported = [];
  const unsupported = [];
  const nodes = [];
  const edges = [];
  for (const record of records) {
    for (const candidate of record.result.unsupportedFrameworkCommands || []) unsupported.push(candidate);
    for (const candidate of record.result.frameworkCommands || []) {
      const target = findSymbol(record.relativePath, candidate.targetType, candidate.targetName);
      if (!target) {
        unsupported.push({ path: record.relativePath, adapter: candidate.adapter, commandName: candidate.commandName, reason: "exact-command-target-symbol-not-found" });
        continue;
      }
      const entryKind = candidate.adapter === "django" ? "django-management-command" : "framework-command";
      const id = `command:${record.relativePath}:${candidate.adapter}:${candidate.commandName}`;
      const evidence = {
        ...candidate.evidence,
        kind: entryKind,
        adapter: candidate.adapter,
        commandName: candidate.commandName,
        targetId: target.id,
      };
      const node = {
        id,
        kind: "command",
        type: "command",
        entryKind,
        label: candidate.adapter === "django" ? `python manage.py ${candidate.commandName}` : `${candidate.adapter} ${candidate.commandName}`,
        path: record.relativePath,
        commandName: candidate.commandName,
        targetPath: target.path,
        targetId: target.id,
        adapter: candidate.adapter,
        domain: record.node.domain,
        feature: record.node.feature,
        layer: record.node.layer || "application",
        sourceScope: record.node.sourceScope,
        detectedResponsibility: candidate.adapter === "django"
          ? "Exact Django management command declaration targeting one top-level Command class with a direct handle method."
          : `Exact ${candidate.adapter} command decorator targeting one top-level function.`,
        methods: [],
        language: record.node.language,
        analysis: { parser: "python-lezer", status: entryKind, confidence: "exact" },
        evidence,
        manualDescription: descriptions[id] || "",
      };
      nodes.push(node);
      edges.push({ source: id, target: target.id, type: "declares-command-target", confidence: "exact", evidence });
      supported.push({
        id,
        ...(candidate.adapter === "django" ? {} : { adapter: candidate.adapter }),
        path: record.relativePath,
        commandName: candidate.commandName,
        targetPath: target.path,
        targetId: target.id,
      });
    }
  }
  return { nodes, edges, supported, unsupported };
}

function buildFlows(nodes, edges, flowEntries = {}) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  const includesEntry = (node) => {
    if (!isSupportedFlowEntryNode(node)) return false;
    if (node.sourceScope === "test") return flowEntries.tests === true;
    if (node.sourceScope === "fixture") return flowEntries.fixtures === true;
    return node.sourceScope === "application" || !node.sourceScope;
  };
  const includesStep = (node) => !["test", "fixture", "generated"].includes(node.sourceScope);
  const entries = nodes.filter(includesEntry);
  // Structural file/symbol edges describe containment, not execution. Entry
  // families declare their exact first static relationship, then projections
  // follow non-containment technical relationships only.
  const flowTargets = (entry, current, edge) => {
    if (current.depth === 0 && entry.kind === "endpoint") return edge.type === "handles";
    if (current.depth === 0 && entry.kind === "command") return edge.type === "declares-command-target";
    if (current.depth === 0 && entry.kind === "schedule") return edge.type === "schedules";
    return !["contains", "declares"].includes(edge.type);
  };
  // A route/controller, arbitrary script, or unqualified scheduler call is not
  // automatically a static entry. Only registered supported entry facts may
  // initiate a Flow Lens.
  return entries.map((entry) => {
    const queue = [{ id: entry.id, depth: 0 }];
    const visited = new Set();
    const steps = [];
    while (queue.length && steps.length < 24) {
      const current = queue.shift();
      if (visited.has(current.id) || current.depth > 6) continue;
      visited.add(current.id);
      const node = byId.get(current.id);
      if (!node || !includesStep(node)) continue;
      steps.push({ id: node.id, label: node.label, type: node.type, depth: current.depth });
      for (const edge of outgoing.get(current.id) || []) {
        if (flowTargets(entry, current, edge)) queue.push({ id: edge.target, depth: current.depth + 1 });
      }
    }
    const entryContract = entry.kind === "endpoint"
      ? createHttpFlowEntry(entry)
      : entry.kind === "schedule"
        ? createNodeCronScheduleFlowEntry(entry)
        : ["django-management-command", "framework-command"].includes(entry.entryKind)
          ? createFrameworkCommandFlowEntry(entry)
          : createPackageScriptFlowEntry(entry);
    return { id: `flow:${entry.id}`, title: entry.label, entryId: entry.id, entry: entryContract, steps };
  });
}

function fileFingerprint(absolutePath) {
  const stat = fs.statSync(absolutePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function isScannableFile(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    return stat.isFile() && isRegisteredSourcePath(absolutePath) && stat.size <= 1_000_000;
  } catch {
    return false;
  }
}

function createFileRecord(root, absolutePath, sourceScope, goFact = null, sourceOverride = null) {
  const relativePath = toPosix(path.relative(root, absolutePath));
  const content = (typeof sourceOverride === "string" ? sourceOverride : fs.readFileSync(absolutePath, "utf8")).replace(/\r\n?/gu, "\n");
  const descriptor = sourceDescriptor(absolutePath);
  return {
    absolutePath,
    relativePath,
    extension: descriptor.extension,
    language: descriptor.language,
    sourceScope,
    fingerprint: fileFingerprint(absolutePath),
    sourceHash: createHash("sha256").update(content).digest("hex"),
    result: analyzeFile(content, descriptor.extension, relativePath, root, goFact),
  };
}

function sourceFingerprint(sourceRecords) {
  const payload = sourceRecords
    .map((record) => `${record.relativePath}\u0000${record.sourceScope}\u0000${record.sourceHash}`)
    .sort()
    .join("\n");
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function createFileNode(record, descriptions) {
  const classification = classifyFile(record.relativePath);
  const sourceScope = record.sourceScope || "application";
  if (sourceScope === "test") {
    classification.type = "test";
    classification.detectedResponsibility = "Verifies application component behavior.";
  } else if (sourceScope === "fixture") {
    classification.detectedResponsibility = "Fixture source retained as static diagnostic evidence.";
  } else if (sourceScope === "generated") {
    classification.detectedResponsibility = "Generated source retained as static diagnostic evidence.";
  }
  if (record.result.analysis.status === "inventory-only") classification.detectedResponsibility = "Known static file retained as inventory only; no structural relationship is inferred.";
  classification.layer = sourceScope;
  return {
    id: `file:${record.relativePath}`,
    kind: "file",
    path: record.relativePath,
    domain: deriveDomain(record.relativePath),
    feature: deriveFeature(record.relativePath),
    ...classification,
    sourceScope,
    methods: record.result.methods,
    language: record.language,
    analysis: record.result.analysis,
    evidence: { file: record.relativePath },
    manualDescription: descriptions[`file:${record.relativePath}`] || "",
  };
}

function createGoPackageNode(packagePath, files, descriptions) {
  return {
    id: `go-package:${packagePath}`,
    kind: "package",
    type: "package",
    label: packagePath === "." ? "Root Go package" : titleCase(path.basename(packagePath)),
    path: packagePath,
    domain: deriveDomain(packagePath),
    feature: deriveFeature(packagePath),
    layer: "application",
    detectedResponsibility: "Internal Go package resolved statically from go.mod.",
    methods: [],
    language: "go",
    analysis: { parser: "go-module-resolver", status: "resolved-import", confidence: "exact" },
    evidence: { file: packagePath },
    manualDescription: descriptions[`go-package:${packagePath}`] || "",
    files,
  };
}

function createGraphContext(root, options = {}) {
  const packageJson = safelyReadJson(path.join(root, "package.json"), {});
  const resolveConfiguredImport = createConfiguredResolver(root);
  const resolveBundlerAlias = createBundlerAliasResolver(root);
  const resolveWorkspaceImport = createWorkspaceResolver(root, packageJson);
  const resolveYarnPnpImport = createYarnPnpResolver(root);
  const resolvePackageImport = createPackageImportsResolver(root);
  const resolveGoModuleImport = createGoModuleResolver(root, options.sourcePaths || null);
  const resolvedImports = new Map();
  const resolveImportedPath = (record, imported) => {
    const key = `${record.extension}\u0000${record.relativePath}\u0000${imported.specifier}`;
    if (resolvedImports.has(key)) return resolvedImports.get(key);
    const resolved = record.extension === ".go"
      ? resolveGoModuleImport(imported.specifier)
      : record.extension === ".rs"
        ? resolveRustImport(root, record.absolutePath, imported.specifier)
      : imported.language === "python"
        ? resolvePythonImport(root, record.absolutePath, imported.specifier)
        : resolveInternalImport(root, record.absolutePath, imported.specifier, resolveConfiguredImport)
          || resolveBundlerAlias(record.absolutePath, imported.specifier)
          || resolvePackageImport(record.absolutePath, imported.specifier)
          || resolveWorkspaceImport(imported.specifier)
          || resolveYarnPnpImport(imported.specifier);
    resolvedImports.set(key, resolved || null);
    return resolved || null;
  };
  return {
    packageJson,
    devPackages: new Set(Object.keys(packageJson.devDependencies || {})),
    resolveImportedPath,
  };
}

// Produce only import facts needed by StructuralFactBatch/v1. This runs after
// parsing and resolver-context preparation, before public graph assembly, so a
// native graph builder never needs JavaScript graph edges as an import oracle.
function structuralImportFacts(sourceRecords, graphContext, options = {}) {
  // An incremental consumer may resolve only a changed subset, but resolution
  // must still be checked against the complete current source-path inventory.
  // Callers must supply that inventory explicitly; this prevents a partial
  // batch from turning an unchanged local import into an external import.
  const knownPaths = options.knownPaths instanceof Set
    ? new Set(options.knownPaths)
    : new Set(sourceRecords.map((record) => record.relativePath));
  const profile = typeof options.onProfile === "function" ? options.onProfile : null;
  const resolutionProfile = new Map();
  const factsByPath = new Map();
  for (const record of sourceRecords) {
    const resolvedImports = [];
    const resolvedPackages = [];
    const externalImports = [];
    for (const imported of record.result?.imports || []) {
      if (!imported || imported.standard || typeof imported.specifier !== "string") continue;
      const resolutionStarted = profile ? process.hrtime.bigint() : null;
      const resolved = graphContext.resolveImportedPath(record, imported);
      if (resolutionStarted) {
        const language = record.language || record.extension || "unknown";
        const current = resolutionProfile.get(language) || { language, imports: 0, milliseconds: 0, internal: 0, package: 0, unresolved: 0 };
        current.imports += 1;
        current.milliseconds += Number(process.hrtime.bigint() - resolutionStarted) / 1_000_000;
        if (typeof resolved === "string") current.internal += 1;
        else if (resolved?.kind === "go-package") current.package += 1;
        else current.unresolved += 1;
        resolutionProfile.set(language, current);
      }
      if (typeof resolved === "string" && knownPaths.has(resolved)) {
        resolvedImports.push({ specifier: imported.specifier, targetPath: resolved });
        continue;
      }
      if (resolved?.kind === "go-package" && typeof resolved.path === "string" && Array.isArray(resolved.files)) {
        const packageNode = createGoPackageNode(resolved.path, resolved.files, {});
        const { id: _id, kind: _kind, type: _type, path: _path, manualDescription: _manualDescription, ...metadata } = packageNode;
        resolvedPackages.push({ specifier: imported.specifier, packagePath: resolved.path, files: resolved.files, metadata });
        continue;
      }
      if (imported.internal || imported.specifier.startsWith(".") || NODE_BUILTINS.has(imported.specifier.replace("node:", ""))) continue;
      const external = createExternalNode(imported.specifier, graphContext.devPackages);
      const {
        id: _id,
        kind: _kind,
        type: _type,
        path: _path,
        manualDescription: _manualDescription,
        ...metadata
      } = external;
      externalImports.push({ specifier: imported.specifier, nodeType: external.type, metadata });
    }
    factsByPath.set(record.relativePath, {
      resolvedImports: resolvedImports.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.targetPath.localeCompare(right.targetPath)),
      resolvedPackages: resolvedPackages.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.packagePath.localeCompare(right.packagePath)),
      externalImports: externalImports.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.nodeType.localeCompare(right.nodeType)),
    });
  }
  if (profile) {
    profile({
      phase: "native-fact-import-resolution-breakdown",
      languages: [...resolutionProfile.values()]
        .map((entry) => ({ ...entry, milliseconds: Number(entry.milliseconds.toFixed(3)) }))
        .sort((left, right) => right.milliseconds - left.milliseconds || left.language.localeCompare(right.language)),
    });
  }
  return factsByPath;
}

// File classification is derived from a parser record plus local authored
// description state; it does not require nodes produced by graph assembly.
function structuralFileFacts(root, sourceRecords) {
  const descriptions = readDescriptions(root);
  return new Map(sourceRecords.map((record) => {
    const node = createFileNode(record, descriptions);
    const { id: _id, kind: _kind, type, path: _path, ...metadata } = node;
    return [record.relativePath, { fileNodeType: type, fileMetadata: metadata }];
  }));
}

function structuralEntryFacts(root, sourceRecords) {
  const descriptions = readDescriptions(root);
  const filesByPath = new Map(sourceRecords.map((record) => [record.relativePath, createFileNode(record, descriptions)]));
  const records = sourceRecords.map((record) => ({ ...record, node: filesByPath.get(record.relativePath) }));
  const symbols = new Map();
  for (const record of records) {
    for (const symbol of record.result?.symbols || []) {
      if (!symbol || typeof symbol.type !== "string" || typeof symbol.name !== "string") continue;
      const id = `symbol:${record.relativePath}:${symbol.type}:${symbol.name}`;
      if (!symbols.has(`${record.relativePath}\u0000${symbol.type}\u0000${symbol.name}`)) {
        symbols.set(`${record.relativePath}\u0000${symbol.type}\u0000${symbol.name}`, {
          id,
          path: record.relativePath,
          type: symbol.type,
          label: symbol.name,
        });
      }
    }
  }
  const findSymbol = (relativePath, type, name) => symbols.get(`${relativePath}\u0000${type}\u0000${name}`) || null;
  const packageEntries = packageScriptEntries(root, records, filesByPath, descriptions);
  const frameworkEntries = frameworkCommandEntries(records, findSymbol, descriptions);
  const scheduleEntries = nodeCronScheduleEntries(records, findSymbol, descriptions);
  const entryMetadata = Object.fromEntries([
    ...packageEntries.nodes,
    ...frameworkEntries.nodes,
    ...scheduleEntries.nodes,
  ].map((node) => {
    const { id, kind: _kind, type: _type, path: _path, ...metadata } = node;
    return [id, metadata];
  }).sort(([left], [right]) => left.localeCompare(right)));
  return {
    packageCommands: packageEntries.supported
      .map(({ manifest, scriptName, targetPath }) => ({ manifest, scriptName, targetPath }))
      .sort((left, right) => left.manifest.localeCompare(right.manifest) || left.scriptName.localeCompare(right.scriptName)),
    entryMetadata,
    edgeMetadata: Object.fromEntries([
      ...packageEntries.edges,
      ...frameworkEntries.edges,
      ...scheduleEntries.edges,
    ].map((edge) => [
      `${edge.source}\u0000${edge.target}\u0000${edge.type}`,
      { confidence: edge.confidence, evidence: edge.evidence },
    ]).sort(([left], [right]) => left.localeCompare(right))),
    entryPoints: {
      schemaVersion: "flopeek-static-entry-inventory/v1",
      supported: {
        packageScripts: packageEntries.supported,
        djangoManagementCommands: frameworkEntries.supported.filter((command) => command.id.includes(":django:")),
        frameworkCommands: frameworkEntries.supported.filter((command) => !command.id.includes(":django:")),
        nodeCronSchedules: scheduleEntries.supported,
        limitation: "Only an explicitly supported exact static subset becomes a Flow Lens entry: a direct package runner target, a supported Python framework command declaration, or a literal node-cron registration.",
      },
      unsupported: {
        packageScripts: packageEntries.unsupported,
        djangoManagementCommands: frameworkEntries.unsupported.filter((command) => command.adapter === "django"),
        frameworkCommands: frameworkEntries.unsupported.filter((command) => command.adapter && command.adapter !== "django"),
        nodeCronSchedules: scheduleEntries.unsupported,
        limitation: "Unsupported scripts, framework commands, and schedule registrations are static inventory only. Their absence from Flow Lenses does not prove they cannot run or have no behavior.",
      },
      limitations: [
        "Package scripts are not executed during discovery or scanning.",
        "Shell composition, quoting, environment expansion, package-manager indirection, runner flags, computed configuration, and runtime module loading are not command-entry facts in this version.",
        "Django discovery does not execute settings or app registration. Only a non-private management/commands module with one top-level Command class directly extending the imported BaseCommand binding and one direct handle method is projected.",
        "Click, Typer, and Flask CLI discovery does not import modules or initialize applications. Only direct module/import bindings, direct top-level decorator registrations, and one top-level function target are projected; computed decorators, factory indirection, and non-literal command names remain unsupported.",
        "Scheduler registration is not executed during discovery or scanning. Only the narrow node-cron default-import, literal-expression, exact-local-function subset is projected; scheduler initialization, task timing, callbacks, dynamic expressions, and other scheduler APIs remain unsupported.",
      ],
    },
  };
}

function structuralEdgeFacts(sourceRecords, importFacts, entryFacts) {
  const metadata = new Map();
  const symbols = new Map();
  const runtimeNodes = new Map();
  const endpoints = new Map();
  // Public assembly creates a Go package node only on its first resolved
  // import. Preserve that exact ownership of the package -> file `contains`
  // evidence without handing JavaScript graph topology to the native side.
  const introducedGoPackages = new Set();
  const edge = (source, target, type, confidence, evidence) => {
    metadata.set(`${source}\u0000${target}\u0000${type}`, { confidence, evidence });
  };
  const fileId = (record) => `file:${record.relativePath}`;
  const symbolId = (record, type, name) => `symbol:${record.relativePath}:${type}:${name}`;
  for (const record of sourceRecords) {
    for (const integration of record.result?.integrations || []) {
      if (!integration?.type || !integration?.instance) continue;
      const id = `runtime:${record.relativePath}:${integration.type}:${integration.instance}`;
      runtimeNodes.set(`${record.relativePath}\u0000${integration.instance}`, id);
      edge(fileId(record), id, "initializes", "exact", integration.evidence);
    }
    for (const symbol of record.result?.symbols || []) {
      if (!symbol?.type || !symbol?.name) continue;
      const id = symbolId(record, symbol.type, symbol.name);
      symbols.set(`${record.relativePath}\u0000${symbol.type}\u0000${symbol.name}`, id);
      const confidence = symbol.confidence || "exact";
      edge(id, fileId(record), "declares", confidence, symbol.evidence);
      edge(fileId(record), id, "contains", confidence, symbol.evidence);
    }
  }
  for (const record of sourceRecords) {
    const imports = importFacts.get(record.relativePath) || { resolvedImports: [], resolvedPackages: [], externalImports: [] };
    const resolved = new Map(imports.resolvedImports.map((item) => [item.specifier, item.targetPath]));
    const packages = new Map(imports.resolvedPackages.map((item) => [item.specifier, item]));
    const external = new Set(imports.externalImports.map((item) => item.specifier));
    for (const imported of record.result?.imports || []) {
      if (!imported?.specifier || imported.standard) continue;
      if (resolved.has(imported.specifier)) edge(fileId(record), `file:${resolved.get(imported.specifier)}`, "imports", "exact", imported.evidence);
      else if (packages.has(imported.specifier)) {
        const resolvedPackage = packages.get(imported.specifier);
        const packageId = `go-package:${resolvedPackage.packagePath}`;
        if (!introducedGoPackages.has(resolvedPackage.packagePath)) {
          introducedGoPackages.add(resolvedPackage.packagePath);
          for (const targetPath of resolvedPackage.files || []) {
            edge(packageId, `file:${targetPath}`, "contains", "exact", imported.evidence);
          }
        }
        edge(fileId(record), packageId, "imports", "exact", imported.evidence);
      }
      else if (external.has(imported.specifier)) edge(fileId(record), `external:${packageName(imported.specifier)}`, "uses", "exact", imported.evidence);
    }
    for (const endpoint of record.result?.endpoints || []) {
      if (!endpoint?.method || !endpoint?.route) continue;
      const id = `endpoint:${record.relativePath}:${endpoint.method}:${endpoint.route}`;
      const handler = endpoint.handlerName
        ? symbols.get(`${record.relativePath}\u0000${endpoint.handlerType || "function"}\u0000${endpoint.handlerName}`)
        : null;
      endpoints.set(`${endpoint.method}\u0000${endpoint.route}`, endpoints.get(`${endpoint.method}\u0000${endpoint.route}`) || id);
      edge(id, handler || fileId(record), "handles", endpoint.confidence || (handler ? "exact" : "likely"), endpoint.evidence);
    }
  }
  for (const record of sourceRecords) {
    const imports = importFacts.get(record.relativePath) || { resolvedImports: [], resolvedPackages: [] };
    const resolved = new Map(imports.resolvedImports.map((item) => [item.specifier, item.targetPath]));
    const packages = new Map(imports.resolvedPackages.map((item) => [item.specifier, item]));
    for (const call of record.result?.calls || []) {
      if (!call?.name) continue;
      const source = call.source
        ? symbols.get(`${record.relativePath}\u0000${call.source.type}\u0000${call.source.name}`) || fileId(record)
        : fileId(record);
      const targetName = call.imported?.exportedName || call.name;
      const target = call.imported?.specifier
        ? resolved.has(call.imported.specifier)
          ? symbols.get(`${resolved.get(call.imported.specifier)}\u0000function\u0000${targetName}`)
          : (() => {
            const files = packages.get(call.imported.specifier)?.files || [];
            const matches = files.map((targetPath) => symbols.get(`${targetPath}\u0000function\u0000${targetName}`)).filter(Boolean);
            return matches.length === 1 ? matches[0] : null;
          })()
        : symbols.get(`${record.relativePath}\u0000function\u0000${targetName}`);
      if (target) edge(source, target, "calls", "exact", call.evidence);
    }
    for (const action of record.result?.runtimeActions || []) {
      if (!action?.instance || !action?.type) continue;
      const source = action.source
        ? symbols.get(`${record.relativePath}\u0000${action.source.type}\u0000${action.source.name}`) || fileId(record)
        : fileId(record);
      const target = runtimeNodes.get(`${record.relativePath}\u0000${action.instance}`);
      if (target) edge(source, target, action.type, "exact", action.evidence);
    }
    for (const request of record.result?.requests || []) {
      if (!request?.method || !request?.route) continue;
      const target = endpoints.get(`${request.method}\u0000${request.route}`);
      if (target) edge(fileId(record), target, "requests", "exact", request.evidence);
    }
  }
  for (const [key, value] of Object.entries(entryFacts?.edgeMetadata || {})) metadata.set(key, value);
  return Object.fromEntries([...metadata.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

// Public envelope fields are parser/resolver/session facts, not graph
// topology. Keeping them here lets the JS adapter submit a complete native
// input before `buildGraphFromRecords()` runs. Topology-derived statistics are
// filled by the consumer that actually assembled nodes and edges.
function createPublicGraphEnvelope(prepared, entryFacts = null) {
  if (!prepared || typeof prepared.root !== "string" || !Array.isArray(prepared.sourceRecords) || !prepared.graphContext || !prepared.projectIdentity) {
    throw new TypeError("Public graph envelope requires prepared scanner facts.");
  }
  const { root, sourceRecords, refresh, graphContext, repositoryScope, excludedPaths, projectIdentity } = prepared;
  const coverage = summarizeFileCoverage(sourceRecords);
  const git = readGitMetadata(root);
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt,
    project: {
      root,
      name: graphContext.packageJson.name || path.basename(root),
      projectId: projectIdentity.projectId || null,
      identity: projectIdentity,
      git,
    },
    state: {
      graphVersion: 0,
      materialFingerprint: null,
      sourceFingerprint: sourceFingerprint(sourceRecords),
      sourceRevision: git.revision,
      updatedAt: generatedAt,
      status: "unpersisted",
    },
    analysis: {
      mode: "deterministic",
      refresh: refresh || {
        strategy: "full-content-analysis",
        mode: "full",
        analyzedFiles: sourceRecords.length,
        reusedFiles: 0,
        removedFiles: 0,
        changedPaths: [],
      },
      codeInterpretation: "AST-only for registered language adapters",
      unparsedPolicy: "inventory-only; no dependency or flow is inferred",
      coverage,
      repositoryScope: scopeSummary(repositoryScope || readRepositoryScope(root), sourceRecords, excludedPaths || []),
      cache: {
        graphSchemaVersion: GRAPH_SCHEMA_VERSION,
        validation: "Graph cache payloads are validated on read and before atomic replacement.",
        persistence: "Validated JSON is written to a synchronized temporary file and atomically replaced with bounded retry for transient Windows locks.",
        limitation: "Cache state proves a persisted static graph version, not runtime behavior, a source diff, or business intent.",
      },
      resolution: {
        internal: ["relative imports", "$lib", "@/", "tsconfig/jsconfig baseUrl and paths", "literal aliases from exported Vite/Webpack configs", "safe static Vite/Webpack alias expressions (__dirname, root process.cwd(), path.resolve/join/dirname, new URL/import.meta.url, fileURLToPath(import.meta.url), and constants)", "package.json imports aliases", "static import/node/default/require/types package condition trees", "declared npm and pnpm workspace package entries", "static Yarn PnP JSON workspace package entries", "Python relative and src-package imports", "static Go module packages", "static Rust crate/self/super modules in conventional Cargo src roots"],
        limitations: ["Arbitrary computed Vite/Webpack aliases, custom package conditions, unsupported pnpm YAML constructs, PHP Composer autoloading, Java framework wiring and non-local-static method dispatch, Rust custom Cargo targets and #[path] modules, Go build tags and duplicate package function names, and runtime module loading are not resolved."],
      },
      calls: {
        supported: ["direct identifier calls to top-level local functions", "direct identifier calls to named ES/CommonJS imports resolved inside the repository", "direct identifier calls to top-level local Python functions and named Python imports resolved inside the repository", "direct local Go function calls and aliased Go package selectors resolved inside the repository", "direct local PHP function calls", "direct local Rust functions and named crate/self/super imports", "direct unqualified unique local static Java method calls"],
        limitations: "Java instance/qualified/overloaded method dispatch, Rust macros, qualified module calls, trait dispatch, custom Cargo targets, and #[path] modules, default and namespace imports, PHP Composer/autoloaded functions, Python attribute calls, Go function values, ambiguous package functions, and unaliased package-name mismatches, dependency injection, callbacks, reflection, dynamic loading, and non-literal CommonJS requires are not resolved as call edges.",
      },
      entryPoints: entryFacts?.entryPoints || null,
      adapterCapabilities: getAdapterRegistry(),
      capabilities: getAdapterRegistry().adapters,
    },
    // These source-derived values can be emitted before graph assembly. The
    // remaining counters are added from the native or JS topology later.
    stats: {
      scannedFiles: coverage.summary.scannedFiles,
      parsedFiles: coverage.summary.parsedFiles,
      inventoryOnlyFiles: coverage.summary.inventoryOnlyFiles,
      parseFailedFiles: coverage.summary.parseFailedFiles,
    },
  };
}

function graphStats(coverage, nodes, edges) {
  return {
    scannedFiles: coverage.summary.scannedFiles,
    nodes: nodes.length,
    edges: edges.length,
    services: nodes.filter((node) => node.type === "service").length,
    classes: nodes.filter((node) => node.kind === "symbol" && node.type === "class").length,
    functions: nodes.filter((node) => node.kind === "symbol" && node.type === "function").length,
    calls: edges.filter((edge) => edge.type === "calls").length,
    endpoints: nodes.filter((node) => node.kind === "endpoint").length,
    commandEntries: nodes.filter((node) => node.kind === "command" && ["package-script", "django-management-command", "framework-command"].includes(node.entryKind)).length,
    scheduledEntries: nodes.filter((node) => node.kind === "schedule" && node.entryKind === "node-cron-schedule").length,
    tests: nodes.filter((node) => node.type === "test").length,
    runtimeDependencies: nodes.filter((node) => node.layer === "runtime").length,
    parsedFiles: coverage.summary.parsedFiles,
    inventoryOnlyFiles: coverage.summary.inventoryOnlyFiles,
    parseFailedFiles: coverage.summary.parseFailedFiles,
  };
}

function buildGraphFromRecords(root, sourceRecords, refresh = null, graphContext = null, scope = null, excludedPaths = [], projectIdentity = null, publicEnvelope = null) {
  const context = graphContext || createGraphContext(root);
  const { packageJson, devPackages, resolveImportedPath } = context;
  const descriptions = readDescriptions(root);
  const nodes = [];
  const edges = [];
  const byRelativePath = new Map();
  const records = [];
  const runtimeNodes = new Map();
  for (const sourceRecord of sourceRecords) {
    const { absolutePath, relativePath, result } = sourceRecord;
    const node = createFileNode(sourceRecord, descriptions);
    nodes.push(node);
    byRelativePath.set(relativePath, node);
    records.push({ ...sourceRecord, node });
    for (const integration of result.integrations || []) {
      const key = `${relativePath}\u0000${integration.instance}`;
      const id = `runtime:${relativePath}:${integration.type}:${integration.instance}`;
      const runtimeNode = {
        id,
        kind: "integration",
        type: integration.type,
        label: integration.label,
        path: relativePath,
        domain: node.domain,
        feature: node.feature,
        layer: "runtime",
        sourceScope: node.sourceScope,
        detectedResponsibility: integration.type === "database" ? "Database or ORM client initialized from a static import." : "Queue or worker initialized from a static import.",
        methods: [],
        language: node.language,
        analysis: { parser: "typescript-ast", status: "parsed", confidence: "exact" },
        evidence: integration.evidence,
        manualDescription: descriptions[id] || "",
        package: integration.package,
      };
      runtimeNodes.set(key, runtimeNode);
      nodes.push(runtimeNode);
      edges.push({ source: node.id, target: runtimeNode.id, type: "initializes", confidence: "exact", evidence: integration.evidence });
    }
    const symbolIds = new Set();
    for (const symbol of result.symbols || []) {
      const symbolId = `symbol:${relativePath}:${symbol.type}:${symbol.name}`;
      if (symbolIds.has(symbolId)) continue;
      symbolIds.add(symbolId);
      const symbolNode = {
        id: symbolId,
        kind: "symbol",
        type: symbol.type,
        label: symbol.name,
        path: relativePath,
        domain: node.domain,
        feature: node.feature,
        layer: node.layer,
        sourceScope: node.sourceScope,
        detectedResponsibility: symbol.type === "class" ? "Class declaration extracted from the syntax tree." : "Function declaration extracted from the syntax tree.",
        methods: symbol.methods,
        language: node.language,
        analysis: { parser: symbol.evidence.parser, status: "parsed", confidence: symbol.confidence || "exact" },
        evidence: symbol.evidence,
        manualDescription: descriptions[`symbol:${relativePath}:${symbol.type}:${symbol.name}`] || "",
      };
      nodes.push(symbolNode);
      edges.push({ source: symbolNode.id, target: node.id, type: "declares", confidence: symbol.confidence || "exact", evidence: symbol.evidence });
      edges.push({ source: node.id, target: symbolNode.id, type: "contains", confidence: symbol.confidence || "exact", evidence: symbol.evidence });
    }
  }

  const symbolIndex = new Map(nodes
    .filter((node) => node.kind === "symbol")
    .map((node) => [`${node.path}\u0000${node.type}\u0000${node.label}`, node]));
  const findSymbol = (relativePath, type, name) => symbolIndex.get(`${relativePath}\u0000${type}\u0000${name}`) || null;
  const resolvedInternalImports = new Map();
  const goPackageNodes = new Map();
  const externalNodes = new Map();
  for (const record of records) {
    for (const imported of record.result.imports) {
      if (imported.standard) continue;
      const resolved = resolveImportedPath(record, imported);
      if (resolved && byRelativePath.has(resolved)) {
        if (!resolvedInternalImports.has(record)) resolvedInternalImports.set(record, new Map());
        resolvedInternalImports.get(record).set(imported.specifier, resolved);
        edges.push({ source: record.node.id, target: byRelativePath.get(resolved).id, type: "imports", confidence: "exact", evidence: imported.evidence });
        continue;
      }
      if (resolved?.kind === "go-package") {
        if (!resolvedInternalImports.has(record)) resolvedInternalImports.set(record, new Map());
        resolvedInternalImports.get(record).set(imported.specifier, resolved);
        if (!goPackageNodes.has(resolved.path)) {
          const packageNode = createGoPackageNode(resolved.path, resolved.files, descriptions);
          goPackageNodes.set(resolved.path, packageNode);
          nodes.push(packageNode);
          for (const filePath of resolved.files) {
            const fileNode = byRelativePath.get(filePath);
            if (fileNode) edges.push({ source: packageNode.id, target: fileNode.id, type: "contains", confidence: "exact", evidence: imported.evidence });
          }
        }
        edges.push({ source: record.node.id, target: goPackageNodes.get(resolved.path).id, type: "imports", confidence: "exact", evidence: imported.evidence });
        continue;
      }
      if (imported.internal || imported.specifier.startsWith(".") || NODE_BUILTINS.has(imported.specifier.replace("node:", ""))) continue;
      const key = packageName(imported.specifier);
      if (!externalNodes.has(key)) externalNodes.set(key, createExternalNode(imported.specifier, devPackages));
      edges.push({ source: record.node.id, target: externalNodes.get(key).id, type: "uses", confidence: "exact", evidence: imported.evidence });
    }
    for (const endpoint of record.result.endpoints) {
      const handler = endpoint.handlerName ? findSymbol(record.relativePath, endpoint.handlerType || "function", endpoint.handlerName) : null;
      const handlerBinding = handler ? "exact-symbol" : "file-fallback";
      const endpointNode = {
        id: `endpoint:${record.relativePath}:${endpoint.method}:${endpoint.route}`,
        kind: "endpoint",
        type: "endpoint",
        label: `${endpoint.method} ${endpoint.route}`,
        path: record.relativePath,
        domain: record.node.domain,
        layer: record.node.layer,
        sourceScope: record.node.sourceScope,
        feature: record.node.feature,
        detectedResponsibility: endpoint.detectedResponsibility || "HTTP endpoint detected by the AST parser.",
        methods: [],
        analysis: { parser: endpoint.evidence?.parser || "typescript-ast", status: "parsed", confidence: endpoint.confidence || "exact", handlerBinding },
        handlerId: handler?.id || null,
        handlerBinding,
        contract: endpoint.contract || null,
        evidence: endpoint.evidence,
        manualDescription: descriptions[`endpoint:${record.relativePath}:${endpoint.method}:${endpoint.route}`] || "",
      };
      nodes.push(endpointNode);
      edges.push({ source: endpointNode.id, target: handler?.id || record.node.id, type: "handles", confidence: endpoint.confidence || (handler ? "exact" : "likely"), evidence: endpoint.evidence });
    }
  }
  nodes.push(...externalNodes.values());

  for (const record of records) {
    for (const call of record.result.calls || []) {
      const source = call.source ? findSymbol(record.relativePath, call.source.type, call.source.name) || record.node : record.node;
      const targetPath = call.imported ? resolvedInternalImports.get(record)?.get(call.imported.specifier) : record.relativePath;
      const targetName = call.imported ? call.imported.exportedName : call.name;
      const target = typeof targetPath === "string"
        ? findSymbol(targetPath, "function", targetName)
        : targetPath?.kind === "go-package"
          ? (() => {
            const matches = targetPath.files.map((filePath) => findSymbol(filePath, "function", targetName)).filter(Boolean);
            return matches.length === 1 ? matches[0] : null;
          })()
          : null;
      if (target) edges.push({ source: source.id, target: target.id, type: "calls", confidence: "exact", evidence: call.evidence });
    }
    for (const action of record.result.runtimeActions || []) {
      const source = action.source ? findSymbol(record.relativePath, action.source.type, action.source.name) || record.node : record.node;
      const target = runtimeNodes.get(`${record.relativePath}\u0000${action.instance}`);
      if (target) edges.push({ source: source.id, target: target.id, type: action.type, confidence: "exact", evidence: action.evidence });
    }
  }

  const endpointNodes = nodes.filter((node) => node.kind === "endpoint");
  for (const record of records) {
    for (const request of record.result.requests || []) {
      const target = endpointNodes.find((node) => node.label === `${request.method} ${request.route}`);
      if (target) edges.push({ source: record.node.id, target: target.id, type: "requests", confidence: "exact", evidence: request.evidence });
    }
  }

  const commandEntries = packageScriptEntries(root, records, byRelativePath, descriptions);
  nodes.push(...commandEntries.nodes);
  edges.push(...commandEntries.edges);
  const frameworkCommands = frameworkCommandEntries(records, findSymbol, descriptions);
  nodes.push(...frameworkCommands.nodes);
  edges.push(...frameworkCommands.edges);
  const scheduleEntries = nodeCronScheduleEntries(records, findSymbol, descriptions);
  nodes.push(...scheduleEntries.nodes);
  edges.push(...scheduleEntries.edges);

  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.source}|${edge.target}|${edge.type}`, edge])).values()];
  const sortedNodes = nodes.sort((left, right) => left.label.localeCompare(right.label));
  const coverage = summarizeFileCoverage(records);
  if (publicEnvelope) {
    const graph = {
      ...publicEnvelope,
      stats: graphStats(coverage, sortedNodes, uniqueEdges),
      nodes: sortedNodes,
      edges: uniqueEdges,
    };
    graph.flows = buildFlows(graph.nodes, graph.edges, scope?.flowEntries);
    graph.diagnosticFlows = buildFlows(graph.nodes, graph.edges, { tests: true, fixtures: true });
    return graph;
  }
  const git = readGitMetadata(root);
  const generatedAt = new Date().toISOString();
  const graph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt,
    project: {
      root,
      name: packageJson.name || path.basename(root),
      projectId: projectIdentity?.projectId || null,
      identity: projectIdentity || null,
      git,
    },
    state: {
      graphVersion: 0,
      materialFingerprint: null,
      sourceFingerprint: sourceFingerprint(sourceRecords),
      sourceRevision: git.revision,
      updatedAt: generatedAt,
      status: "unpersisted",
    },
    analysis: {
      mode: "deterministic",
      refresh: refresh || {
        strategy: "full-content-analysis",
        mode: "full",
        analyzedFiles: records.length,
        reusedFiles: 0,
        removedFiles: 0,
        changedPaths: [],
      },
      codeInterpretation: "AST-only for registered language adapters",
      unparsedPolicy: "inventory-only; no dependency or flow is inferred",
      coverage,
      repositoryScope: scopeSummary(scope || readRepositoryScope(root), records, excludedPaths),
      cache: {
        graphSchemaVersion: GRAPH_SCHEMA_VERSION,
        validation: "Graph cache payloads are validated on read and before atomic replacement.",
        persistence: "Validated JSON is written to a synchronized temporary file and atomically replaced with bounded retry for transient Windows locks.",
        limitation: "Cache state proves a persisted static graph version, not runtime behavior, a source diff, or business intent.",
      },
      resolution: {
        internal: ["relative imports", "$lib", "@/", "tsconfig/jsconfig baseUrl and paths", "literal aliases from exported Vite/Webpack configs", "safe static Vite/Webpack alias expressions (__dirname, root process.cwd(), path.resolve/join/dirname, new URL/import.meta.url, fileURLToPath(import.meta.url), and constants)", "package.json imports aliases", "static import/node/default/require/types package condition trees", "declared npm and pnpm workspace package entries", "static Yarn PnP JSON workspace package entries", "Python relative and src-package imports", "static Go module packages", "static Rust crate/self/super modules in conventional Cargo src roots"],
        limitations: ["Arbitrary computed Vite/Webpack aliases, custom package conditions, unsupported pnpm YAML constructs, PHP Composer autoloading, Java framework wiring and non-local-static method dispatch, Rust custom Cargo targets and #[path] modules, Go build tags and duplicate package function names, and runtime module loading are not resolved."],
      },
      calls: {
        supported: ["direct identifier calls to top-level local functions", "direct identifier calls to named ES/CommonJS imports resolved inside the repository", "direct identifier calls to top-level local Python functions and named Python imports resolved inside the repository", "direct local Go function calls and aliased Go package selectors resolved inside the repository", "direct local PHP function calls", "direct local Rust functions and named crate/self/super imports", "direct unqualified unique local static Java method calls"],
        limitations: "Java instance/qualified/overloaded method dispatch, Rust macros, qualified module calls, trait dispatch, custom Cargo targets, and #[path] modules, default and namespace imports, PHP Composer/autoloaded functions, Python attribute calls, Go function values, ambiguous package functions, and unaliased package-name mismatches, dependency injection, callbacks, reflection, dynamic loading, and non-literal CommonJS requires are not resolved as call edges.",
      },
      entryPoints: {
        schemaVersion: "flopeek-static-entry-inventory/v1",
        supported: {
          packageScripts: commandEntries.supported,
          djangoManagementCommands: frameworkCommands.supported.filter((command) => command.id.includes(":django:")),
          frameworkCommands: frameworkCommands.supported.filter((command) => !command.id.includes(":django:")),
          nodeCronSchedules: scheduleEntries.supported,
          limitation: "Only an explicitly supported exact static subset becomes a Flow Lens entry: a direct package runner target, a supported Python framework command declaration, or a literal node-cron registration.",
        },
        unsupported: {
          packageScripts: commandEntries.unsupported,
          djangoManagementCommands: frameworkCommands.unsupported.filter((command) => command.adapter === "django"),
          frameworkCommands: frameworkCommands.unsupported.filter((command) => command.adapter && command.adapter !== "django"),
          nodeCronSchedules: scheduleEntries.unsupported,
          limitation: "Unsupported scripts, framework commands, and schedule registrations are static inventory only. Their absence from Flow Lenses does not prove they cannot run or have no behavior.",
        },
        limitations: [
          "Package scripts are not executed during discovery or scanning.",
          "Shell composition, quoting, environment expansion, package-manager indirection, runner flags, computed configuration, and runtime module loading are not command-entry facts in this version.",
          "Django discovery does not execute settings or app registration. Only a non-private management/commands module with one top-level Command class directly extending the imported BaseCommand binding and one direct handle method is projected.",
          "Click, Typer, and Flask CLI discovery does not import modules or initialize applications. Only direct module/import bindings, direct top-level decorator registrations, and one top-level function target are projected; computed decorators, factory indirection, and non-literal command names remain unsupported.",
          "Scheduler registration is not executed during discovery or scanning. Only the narrow node-cron default-import, literal-expression, exact-local-function subset is projected; scheduler initialization, task timing, callbacks, dynamic expressions, and other scheduler APIs remain unsupported.",
        ],
      },
      adapterCapabilities: getAdapterRegistry(),
      capabilities: getAdapterRegistry().adapters,
    },
    stats: {
      scannedFiles: coverage.summary.scannedFiles,
      nodes: sortedNodes.length,
      edges: uniqueEdges.length,
      services: sortedNodes.filter((node) => node.type === "service").length,
      classes: sortedNodes.filter((node) => node.kind === "symbol" && node.type === "class").length,
      functions: sortedNodes.filter((node) => node.kind === "symbol" && node.type === "function").length,
      calls: uniqueEdges.filter((edge) => edge.type === "calls").length,
      endpoints: sortedNodes.filter((node) => node.kind === "endpoint").length,
      commandEntries: sortedNodes.filter((node) => node.kind === "command" && ["package-script", "django-management-command", "framework-command"].includes(node.entryKind)).length,
      scheduledEntries: sortedNodes.filter((node) => node.kind === "schedule" && node.entryKind === "node-cron-schedule").length,
      tests: sortedNodes.filter((node) => node.type === "test").length,
      runtimeDependencies: sortedNodes.filter((node) => node.layer === "runtime").length,
      parsedFiles: coverage.summary.parsedFiles,
      inventoryOnlyFiles: coverage.summary.inventoryOnlyFiles,
      parseFailedFiles: coverage.summary.parseFailedFiles,
    },
    nodes: sortedNodes,
    edges: uniqueEdges,
  };
  graph.flows = buildFlows(graph.nodes, graph.edges, scope?.flowEntries);
  graph.diagnosticFlows = buildFlows(graph.nodes, graph.edges, { tests: true, fixtures: true });
  return graph;
}

function sameFingerprint(left, right) {
  return left && right && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function relativeChangedPath(root, changedPath) {
  if (typeof changedPath !== "string" || !changedPath) return null;
  const absolutePath = path.resolve(root, changedPath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  const normalized = toPosix(relativePath);
  if (normalized === CONFIG_FILENAME) return normalized;
  if (normalized.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment) || segment.startsWith("."))) return null;
  return normalized;
}

function graphContextMayHaveChanged(root, relativePath) {
  if (relativePath === CONFIG_FILENAME) return true;
  const filename = path.basename(relativePath).toLowerCase();
  // A Go/Rust source-body edit does not alter the resolver's package/module
  // inventory. Additions and removals still invalidate it below through the
  // reconciler's topology result; manifests/configuration remain immediate
  // invalidators. This avoids treating every Go controller body edit as a
  // repository-wide import-resolution change.
  if (filename.endsWith(".json") || filename === "go.mod" || filename === "cargo.toml" || filename === ".pnp.data.json" || filename === "pnpm-workspace.yaml" || filename === "pnpm-workspace.yml" || BUNDLER_CONFIG_FILENAMES.includes(filename)) return true;
  try {
    return fs.statSync(path.resolve(root, relativePath)).isDirectory();
  } catch {
    return !extensionOf(relativePath);
  }
}

function createRepositoryScanner(inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const persistIdentity = options.persistIdentity !== false;
  const sessionProjectId = persistIdentity ? null : options.sessionProjectId || `session:${randomUUID()}`;
  const records = new Map();
  let initialized = false;
  let graphContext = null;
  let repositoryScope = null;
  let repositoryScopeSignature = null;
  let excludedPaths = new Set();
  let projectIdentity = null;
  let sessionGraph = null;
  const initialFilePlan = Array.isArray(options.initialFilePlan)
    ? options.initialFilePlan.map((entry) => {
      const relativePath = typeof entry === "string" ? entry : entry?.path;
      const absolutePath = typeof relativePath === "string" ? path.resolve(root, relativePath) : null;
      const rootRelativePath = absolutePath ? path.relative(root, absolutePath) : null;
      if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)
        || !rootRelativePath || rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)) {
        throw new Error("initialFilePlan must contain repository-relative source paths.");
      }
      return absolutePath;
    })
    : null;
  const initialRecords = Array.isArray(options.initialRecords) ? options.initialRecords : [];
  // Native source batches are a bounded, current-session optimization only.
  // Their text is consumed once below and never enters cached record payloads,
  // StructuralFactBatch/v1, or persistent graph state.
  const initialSourceContents = new Map();
  const sourceBatchStats = { provided: 0, used: 0, discarded: 0 };
  for (const source of Array.isArray(options.initialSourceContents) ? options.initialSourceContents : []) {
    const relativePath = source?.path;
    const content = source?.utf8;
    const sizeBytes = source?.sizeBytes;
    const modifiedAtNs = source?.modifiedAtNs;
    const absolutePath = typeof relativePath === "string" ? path.resolve(root, relativePath) : null;
    const rootRelativePath = absolutePath ? path.relative(root, absolutePath) : null;
    if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)
      || relativePath.includes("\\") || relativePath.split("/").includes("..")
      || !rootRelativePath || rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)
      || typeof content !== "string" || Buffer.byteLength(content, "utf8") > 1_000_000
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[0-9]+$/u.test(modifiedAtNs || "")) {
      throw new Error("initialSourceContents must contain bounded portable UTF-8 source records.");
    }
    if (initialSourceContents.has(relativePath)) throw new Error("initialSourceContents must not repeat a path.");
    initialSourceContents.set(relativePath, { content, sizeBytes, modifiedAtNs });
    sourceBatchStats.provided += 1;
  }
  for (const candidate of initialRecords) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.relativePath !== "string" || !candidate.relativePath) {
      throw new Error("initialRecords must contain cached file records with a repository-relative path.");
    }
    const absolutePath = path.resolve(root, candidate.relativePath);
    const rootRelativePath = path.relative(root, absolutePath);
    if (!rootRelativePath || rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)) {
      throw new Error("initialRecords must not contain paths outside the repository.");
    }
    records.set(candidate.relativePath, { ...candidate, absolutePath });
  }

  const timed = (phase, operation) => {
    if (typeof options.onProfile !== "function") return operation();
    const started = process.hrtime.bigint();
    try { return operation(); }
    finally {
      options.onProfile({ phase, milliseconds: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)) });
    }
  };

  const removeRecordsIn = (relativePath, refresh) => {
    let removed = false;
    for (const candidate of [...records.keys()]) {
      if (candidate === relativePath || candidate.startsWith(`${relativePath}/`)) {
        records.delete(candidate);
        refresh.removedPaths.add(candidate);
        refresh.removedFiles += 1;
        removed = true;
      }
    }
    return removed;
  };

  const needsUpsert = (absolutePath, sourceScope, refresh, force = false) => {
    if (!isScannableFile(absolutePath)) return false;
    const relativePath = toPosix(path.relative(root, absolutePath));
    const current = records.get(relativePath);
    return !((!force || refresh.analyzedPaths.has(relativePath)) && current && current.sourceScope === sourceScope && sameFingerprint(current.fingerprint, fileFingerprint(absolutePath)));
  };

  const upsertFile = (absolutePath, refresh, force = false, goFactByPath = null) => {
    if (!isScannableFile(absolutePath)) return;
    const relativePath = toPosix(path.relative(root, absolutePath));
    const sourceScope = classifyRepositoryPath(relativePath, repositoryScope);
    if (sourceScope === "excluded") {
      excludedPaths.add(relativePath);
      removeRecordsIn(relativePath, refresh);
      return;
    }
    excludedPaths.delete(relativePath);
    const fingerprint = fileFingerprint(absolutePath);
    const current = records.get(relativePath);
    if ((!force || refresh.analyzedPaths.has(relativePath)) && current && current.sourceScope === sourceScope && sameFingerprint(current.fingerprint, fingerprint)) {
      refresh.reusedFiles += 1;
      return;
    }
    const sourceCandidate = initialSourceContents.get(relativePath);
    initialSourceContents.delete(relativePath);
    let sourceOverride = null;
    if (sourceCandidate) {
      try {
        const stat = fs.statSync(absolutePath, { bigint: true });
        if (stat.size === BigInt(sourceCandidate.sizeBytes) && stat.mtimeNs === BigInt(sourceCandidate.modifiedAtNs)) {
          sourceOverride = sourceCandidate.content;
          sourceBatchStats.used += 1;
        } else {
          sourceBatchStats.discarded += 1;
        }
      } catch {
        sourceBatchStats.discarded += 1;
      }
    }
    records.set(relativePath, createFileRecord(root, absolutePath, sourceScope, goFactByPath?.get(path.resolve(absolutePath)) || null, sourceOverride));
    refresh.analyzedPaths.add(relativePath);
    refresh.analyzedFiles += 1;
  };

  const upsertFiles = (absolutePaths, refresh, force = false) => {
    const pending = absolutePaths.filter((absolutePath) => {
      const relativePath = toPosix(path.relative(root, absolutePath));
      return classifyRepositoryPath(relativePath, repositoryScope) !== "excluded" && needsUpsert(absolutePath, classifyRepositoryPath(relativePath, repositoryScope), refresh, force);
    });
    const goFactByPath = goFacts(pending.filter((absolutePath) => extensionOf(absolutePath) === ".go"));
    const csharpFactByPath = csharpFacts(pending.filter((absolutePath) => extensionOf(absolutePath) === ".cs"));
    const facts = new Map([...goFactByPath, ...csharpFactByPath]);
    for (const absolutePath of absolutePaths) upsertFile(absolutePath, refresh, force, facts);
  };

  const reconcileDirectory = (absolutePath, relativePath, refresh) => {
    const present = new Set();
    const candidates = walk(root, absolutePath);
    for (const candidate of candidates) {
      const candidateRelativePath = toPosix(path.relative(root, candidate));
      if (classifyRepositoryPath(candidateRelativePath, repositoryScope) === "excluded") excludedPaths.add(candidateRelativePath);
      else present.add(candidateRelativePath);
    }
    upsertFiles(candidates, refresh);
    for (const candidate of [...records.keys()]) {
      if (candidate.startsWith(`${relativePath}/`) && !present.has(candidate)) {
        records.delete(candidate);
        refresh.removedPaths.add(candidate);
        refresh.removedFiles += 1;
      }
    }
    for (const candidate of [...excludedPaths]) {
      if (candidate.startsWith(`${relativePath}/`) && !fs.existsSync(path.resolve(root, candidate))) excludedPaths.delete(candidate);
    }
  };

  const reconcileAll = (refresh) => {
    excludedPaths = new Set();
    const present = new Set();
    const absolutePaths = !initialized && initialFilePlan
      ? initialFilePlan.filter((absolutePath) => fs.existsSync(absolutePath) && isScannableFile(absolutePath))
      : walk(root);
    for (const absolutePath of absolutePaths) {
      const relativePath = toPosix(path.relative(root, absolutePath));
      if (classifyRepositoryPath(relativePath, repositoryScope) === "excluded") excludedPaths.add(relativePath);
      else present.add(relativePath);
    }
    upsertFiles(absolutePaths, refresh);
    for (const relativePath of [...records.keys()]) {
      if (!present.has(relativePath)) {
        records.delete(relativePath);
        refresh.removedFiles += 1;
      }
    }
  };

  const reconcileChangedPath = (relativePath, refresh) => {
    const absolutePath = path.resolve(root, relativePath);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      return removeRecordsIn(relativePath, refresh);
    }
    if (stat.isDirectory()) {
      reconcileDirectory(absolutePath, relativePath, refresh);
      return true;
    }
    if (!stat.isFile() || !isScannableFile(absolutePath)) {
      excludedPaths.delete(relativePath);
      return removeRecordsIn(relativePath, refresh);
    }
    const topologyChanged = !records.has(relativePath);
    upsertFiles([absolutePath], refresh, true);
    return topologyChanged;
  };

  // Parser-fact preparation is intentionally separable from public graph
  // assembly. It remains JavaScript-owned while the native core consumes the
  // resulting facts, and lets the migration remove JS graph assembly without
  // changing parser behavior or public node-ID construction.
  const prepare = (changedPaths = null) => {
    let nextScope;
    let nextScopeSignature;
    timed("scope-and-identity", () => {
      nextScope = readRepositoryScope(root);
      nextScopeSignature = scopeSignature(nextScope);
      if (!projectIdentity || repositoryScope?.projectId !== nextScope.projectId) {
        const canonicalIdentity = resolveProjectIdentity(root, nextScope.projectId, { persist: persistIdentity });
        projectIdentity = persistIdentity
          ? canonicalIdentity
          : {
            projectId: sessionProjectId,
            canonicalProjectId: canonicalIdentity.projectId,
            source: "session",
            status: "session-only",
            originRemote: canonicalIdentity.originRemote,
            limitation: "This cache-disabled scanner uses a process-local project identity and monotonic graph versions. Context Refs are valid only inside this scanner session and cannot be reused as durable project context.",
          };
      }
    });
    const scopeChanged = repositoryScopeSignature !== null && repositoryScopeSignature !== nextScopeSignature;
    repositoryScope = nextScope;
    repositoryScopeSignature = nextScopeSignature;
    const refresh = {
      strategy: "incremental-content-analysis",
      mode: initialized ? "incremental" : "initial",
      analyzedFiles: 0,
      reusedFiles: 0,
      removedFiles: 0,
      changedPaths: [],
    };
    if (scopeChanged) refresh.scopeChanged = true;
    Object.defineProperty(refresh, "analyzedPaths", { value: new Set(), enumerable: false });
    Object.defineProperty(refresh, "removedPaths", { value: new Set(), enumerable: false });
    let contextChanged = !initialized || changedPaths === null || scopeChanged;
    if (scopeChanged) {
      records.clear();
      graphContext = null;
    }
    timed("source-analysis", () => {
      if (!initialized || changedPaths === null || scopeChanged) {
        if (initialized) refresh.mode = "reconciled";
        reconcileAll(refresh);
        initialized = true;
      } else {
        const uniquePaths = new Set();
        const directoryPaths = new Set();
        let ambiguousChange = false;
        for (const changedPath of changedPaths) {
          const relativePath = relativeChangedPath(root, String(changedPath || ""));
          if (relativePath) {
            let isDirectory = false;
            try {
              isDirectory = fs.statSync(path.resolve(root, relativePath)).isDirectory();
            } catch {
              // A removal can no longer be stat'ed. The reconciler below records any removed source paths.
            }
            if (isDirectory) {
              directoryPaths.add(relativePath);
              contextChanged = true;
              continue;
            }
            uniquePaths.add(relativePath);
            if (graphContextMayHaveChanged(root, relativePath)) contextChanged = true;
          }
          else ambiguousChange = true;
        }
        if (ambiguousChange) {
          refresh.mode = "reconciled";
          contextChanged = true;
          reconcileAll(refresh);
        } else {
          for (const relativePath of directoryPaths) {
            if (reconcileChangedPath(relativePath, refresh)) contextChanged = true;
          }
          for (const relativePath of uniquePaths) {
            if (reconcileChangedPath(relativePath, refresh)) contextChanged = true;
          }
        }
        const sourceChangedPaths = new Set(
          [...uniquePaths].filter((relativePath) => isRegisteredSourcePath(relativePath) || graphContextMayHaveChanged(root, relativePath)),
        );
        for (const relativePath of refresh.analyzedPaths) sourceChangedPaths.add(relativePath);
        for (const relativePath of refresh.removedPaths) sourceChangedPaths.add(relativePath);
        refresh.changedPaths = [...sourceChangedPaths].sort();
      }
    });
    if (refresh.mode === "incremental") refresh.reusedFiles = Math.max(refresh.reusedFiles, records.size - refresh.analyzedFiles);
    timed("resolver-context", () => {
      if (contextChanged || !graphContext) graphContext = createGraphContext(root, {
        sourcePaths: initialFilePlan
          ? initialFilePlan.map((absolutePath) => toPosix(path.relative(root, absolutePath)))
          : null,
      });
    });
    return {
      root,
      sourceRecords: [...records.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      refresh,
      graphContext,
      repositoryScope,
      excludedPaths: [...excludedPaths].sort(),
      projectIdentity,
    };
  };

  const assemble = (prepared, publicEnvelope = null) => {
    if (!prepared || !Array.isArray(prepared.sourceRecords) || !prepared.refresh || !prepared.graphContext || !prepared.projectIdentity) {
      throw new TypeError("Scanner assembly requires a prepared parser-fact state from this scanner session.");
    }
    return timed("graph-assembly", () => {
      const graph = buildGraphFromRecords(
        root,
        prepared.sourceRecords,
        prepared.refresh,
        prepared.graphContext,
        prepared.repositoryScope,
        prepared.excludedPaths,
        prepared.projectIdentity,
        publicEnvelope,
      );
      if (persistIdentity) return graph;
      graph.analysis.cacheState = {
        status: "disabled",
        path: path.join(root, ".flopeek", "graph.json"),
        diagnostics: [],
        contract: null,
        migrated: false,
      };
      advanceSessionGraph(graph, sessionGraph, { changedPaths: prepared.refresh.changedPaths });
      sessionGraph = graph;
      return graph;
    });
  };

  const scan = (changedPaths = null) => assemble(prepare(changedPaths));

  const snapshotRecords = () => [...records.values()]
    .map(({ absolutePath: _absolutePath, ...record }) => record)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const sourceBatchStatus = () => ({ ...sourceBatchStats, pending: initialSourceContents.size });
  return { root, prepare, assemble, scan, snapshotRecords, sourceBatchStatus };
}

function scanRepository(inputRoot, options = {}) {
  return createRepositoryScanner(inputRoot, options).scan();
}

function writeGraphCache(root, graph, options = {}) {
  const result = persistGraphState(root, graph, options);
  return { ...result.cacheResult, graphState: result.graphState, delta: result.delta, previousCache: result.previousCache, previousState: result.previousState };
}

function graphToMermaid(graph, limit = 100) {
  const validId = (id) => id.split("").map((character) => {
    const letter = character.toLowerCase() !== character.toUpperCase();
    const digit = character >= "0" && character <= "9";
    return letter || digit || character === "_" ? character : "_";
  }).join("");
  const label = (value) => value.split("").filter((character) => !["\"", "[", "]"].includes(character)).join("");
  const visibleNodes = graph.nodes
    .filter((node) => node.layer === "application" && (isSupportedFlowEntryNode(node) || ["route", "controller", "service", "repository", "database", "queue"].includes(node.type)))
    .slice(0, limit);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const nodeLines = visibleNodes.map((node) => `  ${validId(node.id)}["${label(node.label)}"]`);
  const edgeLines = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).slice(0, limit * 2).map((edge) => `  ${validId(edge.source)} --> ${validId(edge.target)}`);
  return ["flowchart LR", ...nodeLines, ...edgeLines].join("\n");
}

function saveDescription(root, id, description) {
  const directory = path.join(root, ".flopeek");
  const filePath = path.join(directory, "descriptions.json");
  const descriptions = readDescriptions(root);
  fs.mkdirSync(directory, { recursive: true });
  if (description.trim()) descriptions[id] = description.trim();
  else delete descriptions[id];
  fs.writeFileSync(filePath, JSON.stringify(descriptions, null, 2));
  return descriptions;
}

module.exports = { buildFlows, createPublicGraphEnvelope, createRepositoryScanner, getGitChangedPaths, graphToMermaid, readDescriptions, readGraphCache, scanRepository, saveDescription, structuralEdgeFacts, structuralEntryFacts, structuralFileFacts, structuralImportFacts, writeGraphCache };

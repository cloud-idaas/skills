const core = '@cloud-idaas/core-sdk';
const adapter = '@cloud-idaas/akless-alibabacloud-adapter';
const factory = adapter + '.IDaaSPamAklessCredentialFactory';
const providerFactories = new Set([
  adapter + '.createAlibabaCloudCredentialsProvider',
  factory + '.createAlibabaCloudCredentialsProvider',
  factory + '.createSLSCredentialsProvider',
]);
const coreFactories = new Set([
  core + '.IDaaSCredentialProviderFactory',
  core + '.default.IDaaSCredentialProviderFactory',
]);
const absent = Symbol('absent');
const unknown = Symbol('unknown');
const dynamic = Symbol('dynamic');
const ossSnapshot = Symbol('ossSnapshot');
const fixedSnapshot = Symbol('fixedSnapshot');
const staticFields = ['accessKeyId', 'accessKeySecret', 'secretAccessKey', 'securityToken', 'stsToken'];
const ossSnapshotFields = ['accessKeyId', 'accessKeySecret', 'stsToken'];
const staticEnv = /^(?:ACCESS_KEY_(?:ID|SECRET)|(?:ALIBABA_CLOUD|ALICLOUD|ALIYUN|OSS|SLS)_(?:ACCESS_KEY(?:_(?:ID|SECRET))?|SECRET_ACCESS_KEY|SECURITY_TOKEN|STS_TOKEN|AK|SK))$/;
const credentialField = /^(?:accessKeyId|accessKeySecret|secretAccessKey|secretKey|secretId|securityToken|stsToken)$/i;
const objectMutators = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
const reflectMutators = new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']);
const optionsFields = ['refreshSTSToken', 'credentialsProvider', 'credential'];

function isCoreMethod(callee, method) {
  return callee.endsWith('.' + method) && coreFactories.has(callee.slice(0, -method.length - 1));
}

function familyOf(name) {
  if (/^ali-oss(?:\.default)?$/.test(name)) return 'oss';
  if (/^@alicloud\/log(?:\.default)?$/.test(name)) return 'sls';
  if (/^@alicloud\/pop-core(?:\.default)?(?:\.(?:RPCClient|ROAClient))?$/.test(name)) return 'legacy_openapi';
  if (/^@alicloud\/[a-z][a-z\d-]*-20\d{2}-\d{2}-\d{2}(?:\.default)?$|^aliyun-sdk(?:\.default)?(?:\.[A-Z]\w*)?$/.test(name)) {
    return 'legacy_sdk';
  }
  if (/^@alicloud\/(?:[a-z][a-z\d-]*20\d{6}|openapi-(?:core|client))(?:\.default){0,2}$/.test(name)) {
    return 'openapi';
  }
  return undefined;
}

export function analyzeAuth(ts, files, isProduction) {
  const options = { allowJs: true, noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest, types: [] };
  const host = ts.createCompilerHost(options);
  // Parse only the files already read by the scanner. No project config, imports, or plugins.
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => files.get(name);
  host.getSourceFile = (name) => files.has(name)
    ? ts.createSourceFile(name, files.get(name), options.target, true) : undefined;
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const clients = [];
  const initializationSites = [];
  const errors = [];
  const findings = [];
  let productionCount = 0;

  for (const source of program.getSourceFiles()) {
    const production = isProduction(source.fileName);
    if (production) productionCount++;
    const badSyntax = production ? program.getSyntacticDiagnostics(source) : [];
    if (badSyntax.length) {
      errors.push({ path: source.fileName, line: badSyntax[0].start === undefined ? 1 :
        source.getLineAndCharacterOfPosition(badSyntax[0].start).line + 1, type: 'parse_failed' });
      continue;
    }
    const mutated = new Set();
    const aliases = new Map();
    const contained = new Map();
    const variables = [];
    const calls = [];
    const writes = [];
    const firstTerminal = new WeakMap();
    const symbolOf = (node) => checker.getSymbolAtLocation(node);
    const location = (node) => ({ path: source.fileName,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    function walk(node, visit) {
      visit(node);
      ts.forEachChild(node, (child) => walk(child, visit));
    }
    function rootOf(node) {
      for (;;) {
        const inner = wrappedExpression(node);
        if (inner) node = inner;
        else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
        else return node;
      }
    }
    function addAlias(left, right) {
      if (!left || !right || left === right) return;
      if (!aliases.has(left)) aliases.set(left, new Set());
      if (!aliases.has(right)) aliases.set(right, new Set());
      aliases.get(left).add(right);
      aliases.get(right).add(left);
    }
    function expandReferences(symbols, followMembers = false) {
      const pending = [...symbols];
      for (let i = 0; i < pending.length; i++) {
        const next = new Set(aliases.get(pending[i]));
        if (followMembers) for (const member of contained.get(pending[i]) ?? []) next.add(member);
        for (const alias of next) {
          if (symbols.has(alias)) continue;
          symbols.add(alias);
          pending.push(alias);
        }
      }
    }
    function bindingNames(pattern) {
      if (ts.isIdentifier(pattern)) return [pattern];
      return pattern.elements.flatMap((element) => ts.isBindingElement(element) ? bindingNames(element.name) : []);
    }
    function immutable(expression, depth = 0) {
      if (!expression || depth > 12) return false;
      const value = unwrap(expression, depth, true);
      if (!value) return false;
      if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) ||
          [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind) ||
          isGlobal(value, 'undefined')) return true;
      if ((ts.isBinaryExpression(value) || ts.isTemplateExpression(value)) && stringValue(value, true) !== undefined) return true;
      let receiver;
      let key = memberName(value, true);
      if (key) receiver = value.expression;
      else if (ts.isIdentifier(value)) {
        const binding = declaration(value, true);
        if (binding && ts.isBindingElement(binding) && ts.isObjectBindingPattern(binding.parent) &&
            ts.isVariableDeclaration(binding.parent.parent) && !binding.initializer && !binding.dotDotDotToken) {
          receiver = binding.parent.parent.initializer;
          key = propertyName(binding.propertyName ?? binding.name, true);
        }
      }
      if (!receiver || !key) return false;
      if (isProcessEnv(receiver)) return true;
      const lookedUp = field(receiver, key);
      return typeof lookedUp !== 'symbol' && immutable(lookedUp, depth + 1);
    }
    function mutableReference(symbol) {
      const binding = symbol?.valueDeclaration;
      return symbol && (!binding?.name || !immutable(binding.name)) ? [symbol] : [];
    }
    function memberValue(receiver, key) {
      if (!key) return unknown;
      return field(receiver, key, 0, true);
    }
    function identity(expression, depth = 0) {
      if (!expression || depth > 16) return undefined;
      const inner = wrappedExpression(expression);
      if (inner) return identity(inner, depth + 1);
      if (ts.isIdentifier(expression)) return symbolOf(expression);
      const key = memberName(expression, true);
      if (!key) return undefined;
      const value = memberValue(expression.expression, key);
      return typeof value === 'symbol' ? undefined : identity(value, depth + 1);
    }
    function references(expression, contentsOnly = false, depth = 0) {
      if (!expression || depth > 16) return [];
      const inner = wrappedExpression(expression);
      if (inner) return references(inner, contentsOnly, depth + 1);
      if (ts.isObjectLiteralExpression(expression)) {
        return expression.properties.flatMap((property) => {
          if (ts.isShorthandPropertyAssignment(property)) return mutableReference(checker.getShorthandAssignmentValueSymbol(property));
          if (ts.isSpreadAssignment(property)) return references(property.expression, true, depth + 1);
          return ts.isPropertyAssignment(property) ? references(property.initializer, false, depth + 1) : [];
        });
      }
      if (ts.isArrayLiteralExpression(expression)) {
        return expression.elements.flatMap((element) => ts.isSpreadElement(element)
          ? references(element.expression, true, depth + 1) : references(element, false, depth + 1));
      }
      if (contentsOnly) {
        if (ts.isIdentifier(expression)) {
          const declarationNode = declaration(expression, true);
          return declarationNode && ts.isVariableDeclaration(declarationNode)
            ? references(declarationNode.initializer, true, depth + 1) : [];
        }
        const name = memberName(expression, true);
        if (name) {
          const value = field(expression.expression, name);
          if (typeof value !== 'symbol') return references(value, true, depth + 1);
        }
        return [];
      }
      if (immutable(expression)) return [];
      const exact = identity(expression);
      if (exact) return mutableReference(exact);
      const root = rootOf(expression);
      return ts.isIdentifier(root) ? mutableReference(symbolOf(root)) : [];
    }
    function isOptions(expression) {
      return isProvider(expression) || optionsFields.some((name) => {
        const value = field(expression, name);
        return value !== absent && value !== unknown;
      });
    }
    walk(source, (node) => {
      let target;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
      if (ts.isDeleteExpression(node)) target = node.expression;
      if (target) {
        writes.push(ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? target.expression : target);
      }
      if (ts.isCallExpression(node) && node.arguments.length) {
        const method = unwrap(node.expression, 0, true);
        const name = method && memberName(method, true);
        if (name) {
          const receiver = unwrap(method.expression, 0, true);
          if ((isGlobal(receiver, 'Object') && objectMutators.has(name)) ||
              (isGlobal(receiver, 'Reflect') && reflectMutators.has(name))) {
            writes.push(node.arguments[0]);
          } else if (!(isGlobal(receiver, 'Object') && name === 'freeze')) calls.push(node);
        } else calls.push(node);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) variables.push(node);
    });
    const optionSymbols = new Set();
    for (const variable of variables) {
      const names = bindingNames(variable.name).flatMap((name) => mutableReference(symbolOf(name)));
      for (const name of names) {
        const binding = name.valueDeclaration;
        const isMember = binding && ts.isBindingElement(binding) && ts.isObjectBindingPattern(binding.parent) &&
          binding.parent.parent === variable && !binding.initializer && !binding.dotDotDotToken;
        const value = isMember ? memberValue(variable.initializer, propertyName(binding.propertyName ?? binding.name, true)) :
          ts.isIdentifier(variable.name) ? variable.initializer : unknown;
        if (typeof value === 'symbol') continue;
        const origin = identity(value);
        if (origin) addAlias(name, origin);
        else contained.set(name, new Set(references(value, true)));
        if (isOptions(value)) optionSymbols.add(name);
      }
    }
    expandReferences(optionSymbols);
    for (const write of writes) {
      const target = identity(write);
      if (target) {
        mutated.add(target);
      } else {
        const possible = new Set(references(write));
        expandReferences(possible, true);
        for (const symbol of possible) mutated.add(symbol);
      }
    }
    for (const call of calls) {
      for (const argument of call.arguments) {
        const reachable = new Set(references(argument));
        expandReferences(reachable, true);
        if ([...reachable].some((symbol) => optionSymbols.has(symbol))) {
          for (const symbol of reachable) mutated.add(symbol);
        }
      }
    }
    expandReferences(mutated);

    function conditional(node) {
      for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent) || ts.isIterationStatement(parent, false) ||
            ts.isSwitchStatement(parent) || ts.isCatchClause(parent) ||
            (ts.isTryStatement(parent) && parent.catchClause) ||
            ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) return true;
        if (ts.isBinaryExpression(parent) && child === parent.right &&
            [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
              .includes(parent.operatorToken.kind)) return true;
        if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
          if (!firstTerminal.has(parent)) {
            firstTerminal.set(parent, parent.statements.find((statement) =>
              ts.isReturnStatement(statement) || ts.isThrowStatement(statement)));
          }
          const terminal = firstTerminal.get(parent);
          if (terminal && child.pos > terminal.pos) return true;
        }
      }
      return false;
    }
    function executionScope(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionLike(parent)) return parent;
      }
      return source;
    }
    function allowsAwait(node) {
      const scope = executionScope(node);
      if (scope === source) {
        return !/\.(?:cjs|cts)$/i.test(source.fileName) &&
          (ts.isExternalModule(source) || /\.(?:mjs|mts)$/i.test(source.fileName));
      }
      return scope.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
    }

    function declaration(node, allowConditional = false) {
      const symbol = symbolOf(node);
      const declarations = symbol?.declarations ?? [];
      return declarations.length === 1 && declarations[0].getSourceFile() === source && !mutated.has(symbol) &&
        (allowConditional || !conditional(declarations[0]))
        ? declarations[0] : undefined;
    }
    function nameOf(node) {
      if (!node) return undefined;
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
      return undefined;
    }
    function globalIdentifier(node, name) {
      return !!node && ts.isIdentifier(node) && node.text === name && !symbolOf(node)?.declarations?.length;
    }
    function isGlobal(node, name) {
      if (globalIdentifier(node, name)) return true;
      return !!node && memberName(node, true) === name &&
        globalIdentifier(unwrap(node.expression, 0, true), 'globalThis');
    }
    function stringValue(expression, allowConditional = false, depth = 0) {
      if (!expression || depth > 20) return undefined;
      const value = unwrap(expression, depth, allowConditional);
      if (!value) return undefined;
      if (ts.isStringLiteralLike(value)) return value.text;
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = stringValue(value.left, allowConditional, depth + 1);
        const right = stringValue(value.right, allowConditional, depth + 1);
        return left !== undefined && right !== undefined ? left + right : undefined;
      }
      if (ts.isTemplateExpression(value)) {
        let text = value.head.text;
        for (const span of value.templateSpans) {
          const part = stringValue(span.expression, allowConditional, depth + 1);
          if (part === undefined) return undefined;
          text += part + span.literal.text;
        }
        return text;
      }
      return undefined;
    }
    function propertyName(node, allowConditional = false) {
      if (!node || !ts.isComputedPropertyName(node)) return nameOf(node);
      return stringValue(node.expression, allowConditional);
    }
    function memberName(node, allowConditional = false) {
      if (ts.isPropertyAccessExpression(node)) return node.name.text;
      if (ts.isElementAccessExpression(node)) return stringValue(node.argumentExpression, allowConditional);
      return undefined;
    }
    function resultOf(fn) {
      if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) ||
          ts.isArrowFunction(fn) || ts.isMethodDeclaration(fn)) || fn.parameters.length || !fn.body) return undefined;
      if (!ts.isBlock(fn.body)) return fn.body;
      const last = fn.body.statements.at(-1);
      return last && ts.isReturnStatement(last) && fn.body.statements.slice(0, -1).every(ts.isVariableStatement)
        ? last.expression : undefined;
    }
    function wrappedExpression(node) {
      if (node && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ||
          ts.isNonNullExpression(node))) return node.expression;
      return undefined;
    }
    function unwrap(node, depth = 0, allowConditional = false) {
      if (!node || depth > 20) return undefined;
      const inner = wrappedExpression(node);
      if (inner) return unwrap(inner, depth + 1, allowConditional);
      if (ts.isIdentifier(node)) {
        const decl = declaration(node, allowConditional);
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          return unwrap(decl.initializer, depth + 1, allowConditional);
        }
      }
      if (ts.isCallExpression(node) && node.arguments.length === 0 && ts.isIdentifier(node.expression)) {
        const decl = declaration(node.expression, allowConditional);
        const fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
        const result = resultOf(fn);
        if (result) return unwrap(result, depth + 1, allowConditional);
      }
      return node;
    }
    function imported(node, depth = 0) {
      if (!node || depth > 20) return '';
      const inner = wrappedExpression(node);
      if (inner) return imported(inner, depth + 1);
      if (isGlobal(node, 'process')) return 'node:process.default';
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const base = imported(node.expression, depth + 1);
        const name = memberName(node, true);
        return base && name ? base + '.' + name : '';
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length === 1) {
        const decl = declaration(node.expression, true);
        const loader = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
        const createRequire = loader && ts.isCallExpression(loader) &&
          /^(?:node:)?module(?:\.default)?\.createRequire$/.test(imported(loader.expression, depth + 1));
        if (createRequire || isGlobal(node.expression, 'require')) return stringValue(node.arguments[0], true) ?? '';
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return stringValue(node.arguments[0], true) ?? '';
      }
      if (!ts.isIdentifier(node)) return '';
      const decl = declaration(node, true);
      if (!decl) return '';
      if (ts.isImportClause(decl) && !decl.isTypeOnly) return nameOf(decl.parent.moduleSpecifier) + '.default';
      if (ts.isNamespaceImport(decl) && !decl.parent.isTypeOnly) return nameOf(decl.parent.parent.moduleSpecifier) ?? '';
      if (ts.isImportSpecifier(decl) && !decl.isTypeOnly && !decl.parent.parent.isTypeOnly) {
        return nameOf(decl.parent.parent.parent.moduleSpecifier) + '.' + nameOf(decl.propertyName ?? decl.name);
      }
      if (ts.isImportEqualsDeclaration(decl) && !decl.isTypeOnly && ts.isExternalModuleReference(decl.moduleReference)) {
        return nameOf(decl.moduleReference.expression) ?? '';
      }
      if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) &&
          ts.isVariableDeclaration(decl.parent.parent) && !decl.initializer && !decl.dotDotDotToken) {
        const base = imported(decl.parent.parent.initializer, depth + 1);
        const name = propertyName(decl.propertyName ?? decl.name, true);
        return base && name ? base + '.' + name : '';
      }
      if (ts.isVariableDeclaration(decl)) return imported(unwrap(decl.initializer, 0, true), depth + 1);
      return '';
    }
    function isProvider(expression) {
      const node = unwrap(expression);
      if (!node || (!ts.isCallExpression(node) && !ts.isNewExpression(node))) return false;
      const name = imported(node.expression);
      return name !== factory + '.createOSSCredentialOptions' && isProviderConstruction(node, name);
    }
    function isProviderConstruction(node, name) {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
      const origin = name ?? imported(node.expression);
      return ts.isCallExpression(node) ? providerFactories.has(origin) || origin === factory + '.createOSSCredentialOptions' :
        origin === adapter + '.IDaaSPamAlibabaCloudCredentialsProvider';
    }
    function settlesInitialization(expression, depth = 0) {
      if (depth > 12) return false;
      const call = unwrap(expression);
      if (!call || !ts.isCallExpression(call)) return false;
      if (isCoreMethod(imported(call.expression), 'init')) return true;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'all' &&
          isGlobal(call.expression.expression, 'Promise') && call.arguments.length === 1) {
        const array = unwrap(call.arguments[0]);
        return !!array && ts.isArrayLiteralExpression(array) &&
          array.elements.some((entry) => settlesInitialization(entry, depth + 1));
      }
      if (!ts.isIdentifier(call.expression) || call.arguments.length) return false;
      const binding = declaration(call.expression);
      const fn = binding && ts.isVariableDeclaration(binding) ? binding.initializer : binding;
      if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
          fn.parameters.length || !fn.body || !ts.isBlock(fn.body) ||
          !fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
      for (const statement of fn.body.statements) {
        if (ts.isVariableStatement(statement)) continue;
        if (ts.isReturnStatement(statement)) return settlesInitialization(statement.expression, depth + 1);
        if (!ts.isExpressionStatement(statement)) return false;
        if (ts.isAwaitExpression(statement.expression) && settlesInitialization(statement.expression.expression, depth + 1)) {
          return true;
        }
      }
      return false;
    }
    function isProcessEnv(expression) {
      return /^(?:node:)?process(?:\.default)?\.env$/.test(imported(unwrap(expression, 0, true)));
    }
    function isProviderMethod(node, method) {
      return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === method && isProvider(node.expression.expression);
    }
    function delegatesCredentials(expression) {
      const member = field(expression, 'getCredentials');
      if (typeof member === 'symbol') return false;
      const fn = unwrap(member);
      if (!fn?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
      if (fn.body && ts.isBlock(fn.body) && fn.body.statements.length !== 1) return false;
      let result = resultOf(fn);
      while (wrappedExpression(result)) result = wrappedExpression(result);
      if (!result || !ts.isCallExpression(result) || result.arguments.length ||
          memberName(result.expression) !== 'getCredentials') return false;
      const receiver = result.expression.expression;
      if (isProvider(receiver)) return true;
      if (ts.isArrowFunction(fn) || !memberName(receiver) || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        return false;
      }
      const provider = field(expression, memberName(receiver));
      return typeof provider !== 'symbol' && isProvider(provider);
    }
    function field(expression, key, depth = 0, retainReference = false) {
      if (depth > 20) return unknown;
      const value = unwrap(expression);
      if (!value) return unknown;
      if (isProviderMethod(value, 'getOSSOptions') || (ts.isCallExpression(value) &&
          imported(value.expression) === factory + '.createOSSCredentialOptions')) {
        if (key === 'refreshSTSToken') return dynamic;
        if (key === 'refreshSTSTokenInterval') return unknown;
        return ossSnapshotFields.includes(key) ? ossSnapshot : absent;
      }
      if (isProviderMethod(value, 'getCredentials') || isProviderMethod(value, 'getCredential')) {
        return staticFields.includes(key) ? fixedSnapshot : absent;
      }
      if (ts.isNewExpression(value) && /^@alicloud\/openapi-(?:core|client)(?:\.default)?(?:\.\$?OpenApiUtil)?\.Config$/.test(imported(value.expression))) {
        return field(value.arguments?.[0], key, depth + 1, retainReference);
      }
      if (!ts.isObjectLiteralExpression(value)) return unknown;
      for (const prop of [...value.properties].reverse()) {
        if (ts.isSpreadAssignment(prop)) {
          const spread = field(prop.expression, key, depth + 1, retainReference);
          if (spread !== absent) return spread;
        } else {
          const name = propertyName(prop.name);
          if (name === undefined) return unknown;
          if (name === key) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              const binding = checker.getShorthandAssignmentValueSymbol(prop)?.valueDeclaration;
              return binding && ts.isVariableDeclaration(binding) && !conditional(binding) &&
                !mutated.has(checker.getShorthandAssignmentValueSymbol(prop))
                ? retainReference ? binding.name : binding.initializer ?? unknown : unknown;
            }
            if (ts.isPropertyAssignment(prop)) return prop.initializer;
            return ts.isMethodDeclaration(prop) ? prop : unknown;
          }
        }
      }
      return absent;
    }
    function credentialState(optionsExpression, family) {
      const key = { oss: 'refreshSTSToken', sls: 'credentialsProvider', openapi: 'credential',
        legacy_openapi: 'credentialsProvider', legacy_sdk: 'credentialsProvider' }[family];
      const binding = field(optionsExpression, key);
      const staticValues = staticFields.map((name) => field(optionsExpression, name));
      const fixed = staticValues.some((value) => {
        if (value === fixedSnapshot) return true;
        if (value === absent || value === unknown || value === ossSnapshot) return false;
        const expr = unwrap(value);
        return !!expr && expr.kind !== ts.SyntaxKind.NullKeyword &&
          !(ts.isStringLiteral(expr) && !expr.text) && !(ts.isIdentifier(expr) && expr.text === 'undefined');
      });
      if (fixed) return 'static_auth';
      if (binding === dynamic && family === 'oss') {
        const interval = field(optionsExpression, 'refreshSTSTokenInterval');
        const value = typeof interval === 'symbol' ? undefined : unwrap(interval);
        // ali-oss updates its refresh clock before the callback completes. Only
        // zero keeps the next request checking the provider after a failure.
        return value && ts.isNumericLiteral(value) && Number(value.text) === 0
          ? 'idaas_provider' : 'oss_refresh_interval_unverified';
      }
      if (binding === absent && (family === 'oss' && staticValues.includes(ossSnapshot))) return 'static_auth';
      if (binding === absent || binding === unknown || typeof binding === 'symbol') return 'unresolved';
      if ((family === 'sls' || family === 'legacy_openapi') &&
          (isProvider(binding) || delegatesCredentials(binding))) return 'idaas_provider';
      const value = unwrap(binding);
      if (value && family === 'openapi' && isProviderMethod(value, 'toAlibabaCloudCredential')) return 'idaas_provider';
      if (value && credentialConstructor(value) === 'static_credential_provider') return 'static_auth';
      return 'unresolved';
    }

    function credentialConstructor(node) {
      if (!ts.isNewExpression(node) || !/^@alicloud\/credentials(?:\.default)?$/.test(imported(node.expression))) {
        return undefined;
      }
      const config = node.arguments?.[0];
      if (!config || config.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(config) && config.text === 'undefined')) return 'default_credential_chain';
      const type = field(config, 'type');
      if (typeof type !== 'symbol' && /^(?:access_key|sts)$/.test(nameOf(unwrap(type)) ?? '')) {
        return 'static_credential_provider';
      }
      return undefined;
    }

    const sdkImports = new Map();
    const clientFamilies = new Set();
    const completedInitialization = new Map();
    const factoryClosures = new Map();
    const providerConstructions = [];
    let hasLocalInitialization = false;
    function runtimeImport(node) {
      const clause = node.importClause;
      if (!clause) return true;
      if (clause.isTypeOnly) return false;
      const bindings = clause.namedBindings;
      return Boolean(clause.name) || Boolean(bindings && (ts.isNamespaceImport(bindings) ||
        !bindings.elements.length || bindings.elements.some((element) => !element.isTypeOnly)));
    }
    function reportEnvDestructuring(elements) {
      for (const element of elements) {
        if (!element.dotDotDotToken && staticEnv.test(propertyName(element.propertyName ?? element.name, true) ?? '')) {
          findings.push({ ...location(element), type: 'static_credential_env_read' });
        }
      }
    }
    function reportLiteral(node, name, expression) {
      if (!credentialField.test(name ?? '')) return;
      const value = unwrap(expression, 0, true);
      if (value && ts.isStringLiteralLike(value) && value.text.trim()) {
        findings.push({ ...location(node), type: 'static_credential_literal' });
      }
    }
    walk(source, (node) => {
      const name = memberName(node, true);
      if (name && staticEnv.test(name) && isProcessEnv(node.expression)) {
        findings.push({ ...location(node), type: 'static_credential_env_read' });
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && isProcessEnv(node.initializer)) {
        reportEnvDestructuring(node.name.elements);
      }
      if (ts.isPropertyAssignment(node)) reportLiteral(node, propertyName(node.name, true), node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        reportLiteral(node, memberName(node.left, true), node.right);
        if (ts.isObjectLiteralExpression(node.left) && isProcessEnv(node.right)) {
          reportEnvDestructuring(node.left.properties);
        }
      }
      if (ts.isNewExpression(node)) {
        const authType = credentialConstructor(node);
        if (authType) findings.push({ ...location(node), type: authType });
      }
      if (!production) return;
      if (ts.isAwaitExpression(node) && !conditional(node) && allowsAwait(node) && settlesInitialization(node.expression)) {
        const scope = executionScope(node);
        const sites = completedInitialization.get(scope) ?? [];
        sites.push(node);
        completedInitialization.set(scope, sites);
      }
      if (ts.isImportDeclaration(node) && runtimeImport(node)) {
        const family = familyOf(nameOf(node.moduleSpecifier) ?? '');
        if (family && !/^@alicloud\/openapi-(?:core|client)$/.test(node.moduleSpecifier.text)) sdkImports.set(family, node);
      }
      if (ts.isNewExpression(node)) {
        if (isProviderConstruction(node)) providerConstructions.push(node);
        const family = familyOf(imported(node.expression));
        if (family) {
          clientFamilies.add(family);
          const status = credentialState(node.arguments?.[0], family);
          let reason;
          if (status === 'oss_refresh_interval_unverified') reason = status;
          if (status === 'idaas_provider' && conditional(node)) reason = 'conditional_control_flow';
          clients.push({ ...location(node), family, status: reason ? 'unresolved' : status, reason });
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = imported(node.expression);
        if (isCoreMethod(callee, 'init')) hasLocalInitialization = true;
        if (isCoreMethod(callee, 'close')) {
          const scope = executionScope(node);
          const first = factoryClosures.get(scope);
          if (!first || node.pos < first.pos) factoryClosures.set(scope, node);
        }
        if (isProviderConstruction(node, callee)) providerConstructions.push(node);
        const family = familyOf(imported(node));
        if (family && !/^@alicloud\/openapi-(?:core|client)$/.test(imported(node))) sdkImports.set(family, node);
        if (isProviderMethod(node, 'getCredentials') || isProviderMethod(node, 'getCredential')) {
          const credentialValue = ts.isAwaitExpression(node.parent) ? node.parent : node;
          const parent = credentialValue.parent;
          const propertyAssignment = ts.isBinaryExpression(parent) && parent.right === credentialValue &&
            ts.isPropertyAccessExpression(parent.left) && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
          if ((ts.isVariableDeclaration(parent) &&
              (ts.isSourceFile(parent.parent.parent.parent) || /cache|saved|stored/i.test(nameOf(parent.name) ?? ''))) ||
              propertyAssignment) {
            findings.push({ ...location(propertyAssignment ? parent.left : node), type: 'credential_cache_suspect' });
          }
        }
      }
    });
    const provenSites = new Set(completedInitialization.get(source));
    for (const node of providerConstructions) {
      const scope = executionScope(node);
      const sites = completedInitialization.get(scope) ?? [];
      const closure = factoryClosures.get(scope);
      const mayBeClosed = closure && closure.getStart(source) < node.getStart(source);
      const prior = sites.find((site) => site.getEnd() <= node.getStart(source));
      if (prior && !mayBeClosed) provenSites.add(prior);
      else if (hasLocalInitialization || mayBeClosed) {
        findings.push({ ...location(node), type: 'initialization_before_provider_unverified' });
      }
    }
    initializationSites.push(...[...provenSites].map(location));
    for (const [family, node] of sdkImports) {
      if (!clientFamilies.has(family)) clients.push({ ...location(node), family, status: 'unresolved' });
    }
  }
  const reviewRequired = !clients.length || clients.some(({ status }) => status === 'unresolved');
  return { clients, errors, findings, initializationSites, syntaxComplete: errors.length === 0, reviewRequired,
    reason: productionCount === 0 ? 'no_production_sources' : clients.length === 0 ? 'no_production_clients' : undefined,
    runtimeOrderVerified: false };
}

"""Local AK-less scanning helpers for this skill. Maintain in this folder."""
import os
import re
import sys

RE_AK_LITERAL = re.compile(r"\bLTAI[A-Za-z0-9]{12,28}\b")
RE_CREDENTIAL_ENV_NAME = re.compile(
    r'(?i)(?:^|_)(?:client_?secret|access_?key(?:_?(?:id|secret))?'
    r'|secret_?access_?key|secret_?key|security_?token)$')

# Non-code config-file sweep
CONFIG_EXTS = (".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf",
               ".properties", ".env", ".sh", ".bash", ".tf")
CONFIG_FILENAMES = {"dockerfile", "jenkinsfile", "makefile"}
MAX_CONFIG_BYTES = 2 * 1024 * 1024
RE_CFG_SECRET_ASSIGN = re.compile(
    r"(?i)(access[_-]?key[_-]?(?:id|secret)?|secret[_-]?access[_-]?key|secret[_-]?key"
    r"|security[_-]?token|credential[_-]?(?:id|secret)|client[_-]?secret"
    r"|[A-Z][A-Z0-9_]*_(?:AK|SK)|archive[.-](?:ak|sk))[\"']?\s*[:=]\s*"
    r'''("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,\r\n]+)''')
RE_CFG_JVM_SECRET = re.compile(
    r'''-D(archive\.(?:ak|sk))=("(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)''', re.I)
# Only explicit references and complete marker values are placeholders. A real
# secret may start with words such as test/none/example and must still be found.
# Spring's ${property:} has an empty default; non-empty literal defaults still fail.
# Kebab-case Spring properties are references; uppercase ${ENV-fallback} remains
# ambiguous shell-default syntax and must be reviewed rather than exempted.
RE_CFG_PLACEHOLDER = re.compile(
    r"(?ix)(?:\$\{(?:(?!(?-i:[A-Z_][A-Z0-9_]*-))[A-Z_][A-Z0-9_.-]*|[A-Z_][A-Z0-9_.-]*:)\}|\$[A-Z_][A-Z0-9_]*|\{\{.*?\}\}|<[^>]+>"
    r"|(?:sample|example|placeholder|dummy|test|fake|changeme|null|none|true|false)"
    r"|replace[_-]?me(?:[_-][A-Z0-9_-]+)?|\*+|x{3,})\Z")


def quoted_end(source, start):
    """Return the end of a Go/Java literal, including raw strings/text blocks."""
    delimiter = '"""' if source.startswith('"""', start) else source[start]
    index = start + len(delimiter)
    while index < len(source):
        if source[index] == "\\" and delimiter != '`':
            index += 2
        elif source.startswith(delimiter, index):
            return index + len(delimiter)
        else:
            index += 1
    return len(source)


def strip_comments(content):
    """Strip comments across the whole file, preserving literals and line numbers.

    A raw string or Java text block may span lines containing comment markers.
    Keep its state until its closing delimiter before interpreting comments.
    """
    out = []
    index = 0
    while index < len(content):
        if content[index] in ('"', "'", '`'):
            end = quoted_end(content, index)
            out.append(content[index:end])
        elif content.startswith('//', index):
            end = content.find('\n', index)
            if end == -1:
                end = len(content)
            out.append(' ')
        elif content.startswith('/*', index):
            end = content.find('*/', index + 2)
            end = len(content) if end == -1 else end + 2
            # A comment separates tokens; removing it must not join identifiers.
            out.append(' ' + '\n' * content.count('\n', index, end))
        else:
            out.append(content[index])
            end = index + 1
        index = end
    # Retain the existing splitlines contract (no extra trailing newline).
    return "\n".join("".join(out).splitlines())


def iter_code_units(content):
    """Yield comment-free call-sized units and their original starting lines.

    Balance parentheses outside quoted literals, including nested calls. Keep
    chained calls together so ordinary formatting cannot hide authentication.
    This is a lexical check, not type or data-flow analysis.
    """
    lines = strip_comments(content).splitlines()
    # One backward pass replaces repeated tail slicing / lookahead (O(n²)).
    following_lines = [""] * len(lines)
    following = ""
    for index in range(len(lines) - 1, -1, -1):
        following_lines[index] = following
        if lines[index].strip():
            following = lines[index].lstrip()
    pending = []
    depth = 0
    start = 1
    quote = None
    for index, line in enumerate(lines):
        if not pending:
            start = index + 1
        pending.append(line)
        column = 0
        while column < len(line):
            char = line[column]
            if quote:
                if char == "\\" and quote != "`":
                    column += 2
                    continue
                if line.startswith(quote, column):
                    column += len(quote)
                    quote = None
                    continue
            elif char in ('"', "'", '`'):
                quote = '"""' if line.startswith('"""', column) else char
                column += len(quote)
                continue
            elif char == "(":
                depth += 1
            elif char == ")":
                depth = max(0, depth - 1)
            column += 1
        following = following_lines[index]
        if depth == 0 and quote is None and not following.startswith((".", "(")):
            yield start, " ".join(pending)
            pending = []
    if pending:
        yield start, " ".join(pending)


def iter_repo_files(root, skip_dirs, read_errors=None):
    """Walk selected directories without silently swallowing traversal failures."""
    def onerror(error):
        if read_errors is None:
            raise error
        diagnostic = {"file": os.path.relpath(error.filename or root, root),
                      "line": 0, "kind": "read_error",
                      "text": "Directory could not be read; scan incomplete"}
        if diagnostic not in read_errors:
            read_errors.append(diagnostic)

    for dirpath, dirnames, filenames in os.walk(root, onerror=onerror):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fn in filenames:
            yield os.path.join(dirpath, fn)


def is_test_source(filepath, root):
    """Test setup cannot satisfy production IDaaS initialization checks."""
    relative = '/' + os.path.relpath(filepath, root).replace(os.sep, '/')
    return relative.endswith('_test.go') or '/src/test/' in relative


def iter_config_files(root, skip_dirs, read_errors=None):
    """Select config files; size limits are reported by scan_config_file."""
    for fp in iter_repo_files(root, skip_dirs, read_errors):
        fn = os.path.basename(fp)
        if (fn.endswith(CONFIG_EXTS) or fn.lower() in CONFIG_FILENAMES or fn.startswith(".env")
                or fn.lower().startswith("dockerfile.") or fn.lower().endswith(".dockerfile")):
            yield fp


def config_assignment_value(raw, hash_comments=False):
    """Remove scalar delimiters, retaining expressions with literal defaults."""
    value = raw.strip()
    if value.startswith(('"', "'")):
        return value[1:-1].strip()
    if hash_comments:
        # YAML / dotenv / shell comments require separation from an unquoted
        # value. A hash inside a quoted value or ${VAR}#suffix remains data.
        value = re.split(r'[ \t]+#', value, maxsplit=1)[0].rstrip()
    return value


def yaml_block_value(lines, index):
    """Read an indented YAML literal/folded scalar until the next sibling."""
    parent_indent = re.match(r'\s*(?:-\s+)?', lines[index]).end()
    parts = []
    for offset in range(index + 1, len(lines)):
        line = lines[offset]
        if line.strip() and len(line) - len(line.lstrip()) <= parent_indent:
            break
        parts.append(line.strip())
    return "\n".join(parts).strip()


def iter_yaml_env_entries(lines):
    """Read block-style YAML env lists without joining separate entries.

    This is a bounded structural check, not a general YAML/template parser.
    Only direct name/value/valueFrom fields in an env item are considered.
    """
    env_indent = item_indent = field_indent = None
    entry = {}
    for index, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip(' '))
        item = re.match(r'^( *)- +(name|value|valueFrom)\s*:\s*(.*)$', line)
        if env_indent is not None:
            if indent < env_indent or (indent == env_indent and not item):
                if entry:
                    yield entry
                env_indent = item_indent = field_indent = None
                entry = {}
            elif item and (item_indent is None or indent == item_indent):
                if entry:
                    yield entry
                item_indent, field_indent = indent, item.start(2)
                entry = {}
            elif item_indent is None or indent != field_indent:
                continue
        if env_indent is None:
            if re.fullmatch(r' *env:\s*(?:#.*)?', line):
                env_indent = indent
            continue
        field = item or re.match(r' *(name|value|valueFrom)\s*:\s*(.*)$', line)
        if not field:
            continue
        key, raw = field.groups()[-2:]
        # Strip comments after complete quoted scalars without exposing values.
        scalar = re.fullmatch(r'''("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|.*?)(?:\s+#.*)?''', raw)
        raw = scalar.group(1).strip()
        value = (yaml_block_value(lines, index) if re.fullmatch(r'[|>][1-9+-]*', raw)
                 else config_assignment_value(raw, hash_comments=True))
        entry[key] = (value, index + 1)
    if entry:
        yield entry


def scan_yaml_env_credentials(lines, rel):
    """Flag suspected inline credentials for review; never assert validity."""
    for entry in iter_yaml_env_entries(lines):
        name = entry.get('name', ('', 0))[0]
        value, line = entry.get('value', ('', 0))
        if ('valueFrom' in entry or not RE_CREDENTIAL_ENV_NAME.search(name) or not value
                or RE_CFG_PLACEHOLDER.fullmatch(value)
                or re.fullmatch(r'\$\([A-Za-z_][A-Za-z0-9_]*\)', value)):
            continue
        yield {'file': rel, 'line': line, 'kind': 'k8s_env_credential_suspect',
               'severity': 'warning', 'text': 'Suspected inline credential in YAML env; review required [REDACTED]'}


def yaml_env_value_lines(lines):
    """Give sensitive env values to the structural rule, including block scalars.

    The generic assignment regex must not reinterpret text inside an env value
    (such as ${IDAAS_CLIENT_SECRET:default}) as a second configuration key.
    Literal AK detection still runs independently on every line.
    """
    owned = set()
    for entry in iter_yaml_env_entries(lines):
        if 'value' not in entry or not RE_CREDENTIAL_ENV_NAME.search(entry.get('name', ('', 0))[0]):
            continue
        line = entry['value'][1]
        owned.add(line)
        if re.search(r':\s*[|>][1-9+-]*\s*(?:#.*)?$', lines[line - 1]):
            indent = len(lines[line - 1]) - len(lines[line - 1].lstrip())
            for index in range(line, len(lines)):
                if lines[index].strip() and len(lines[index]) - len(lines[index].lstrip()) <= indent:
                    break
                owned.add(index + 1)
    return owned


def scan_config_file(fp, root_dir):
    """Sweep one non-code file for literal AKs / plaintext secret assignments."""
    hits = []
    rel = os.path.relpath(fp, root_dir)
    try:
        if os.path.getsize(fp) > MAX_CONFIG_BYTES:
            return [{"file": rel, "line": 0, "kind": "read_error",
                     "text": "Configuration exceeds 2 MiB limit; scan incomplete"}]
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(MAX_CONFIG_BYTES + 1)
        if len(content.encode('utf-8')) > MAX_CONFIG_BYTES:
            return [{"file": rel, "line": 0, "kind": "read_error",
                     "text": "Configuration exceeds 2 MiB limit; scan incomplete"}]
        lines = content.splitlines()
    except (IOError, OSError) as e:
        print("Warning: Failed to read %s: %s" % (fp, e), file=sys.stderr)
        return [{"file": rel, "line": 0, "kind": "read_error",
                 "text": "Configuration could not be read; scan incomplete"}]
    env_values = yaml_env_value_lines(lines) if fp.endswith(('.yaml', '.yml')) else set()
    for line_no, ln in enumerate(lines, 1):
        if RE_AK_LITERAL.search(ln):
            hits.append({"file": rel, "line": line_no, "kind": "ak_literal", "text": "[REDACTED]"})
            continue
        if line_no in env_values:
            continue
        assignments = list(RE_CFG_JVM_SECRET.finditer(ln))
        generic_line = ln
        for argument in reversed(assignments):
            generic_line = (generic_line[:argument.start()] + ' ' * (argument.end() - argument.start())
                            + generic_line[argument.end():])
        assignments.extend(RE_CFG_SECRET_ASSIGN.finditer(generic_line))
        for m in assignments:
            raw = m.group(2).strip()
            hash_comments = (fp.endswith(('.yaml', '.yml', '.sh', '.bash'))
                             or os.path.basename(fp).startswith('.env'))
            value = config_assignment_value(raw, hash_comments=hash_comments)
            if fp.endswith(('.yaml', '.yml')) and re.fullmatch(
                    r'[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?', raw):
                value = yaml_block_value(lines, line_no - 1)
            if len(value) >= 6 and not RE_CFG_PLACEHOLDER.fullmatch(value.strip()):
                hits.append({"file": rel, "line": line_no, "kind": "config_secret", "text": "[REDACTED]"})
    if fp.endswith(('.yaml', '.yml')):
        hits.extend(scan_yaml_env_credentials(lines, rel))
    return hits



def go_package_call(content, path, methods):
    """Bind constructor rules to explicit Go imports, including local aliases."""
    bindings = re.findall(r'(?:\bimport\s+(?:\(\s*)?|(?m:^[ \t]*))(?:(\w+)\s+)?'
                          + re.escape('"' + path + '"'), strip_comments(content))
    names = [name or path.rsplit('/', 1)[-1] for name in bindings if name not in ('_', '.')]
    return re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\s*\.\s*(?:'
                      + methods + r')\s*\(') if names else re.compile(r'(?!)')


def java_constructor(content, qualified):
    """An unrelated explicit short-name import must not acquire cloud semantics."""
    short = qualified.rsplit('.', 1)[-1]
    code = strip_comments(content)
    names = [re.escape(qualified)]
    if re.search(r'\bimport\s+' + re.escape(qualified) + r'\s*;', code):
        names.append(re.escape(short))
    return re.compile(r'\bnew\s+(?:' + '|'.join(names) + r')\s*\(')


def iter_additional_auth_findings(content, language):
    """Report proven constructor choices, and bounded review-only auth paths."""
    if language == 'go':
        rules = [
            (go_package_call(content, 'github.com/aliyun/alibaba-cloud-sdk-go/sdk',
                             'NewClientWithAccessKey|NewClientWithStsToken'), 3, 'openapi_static_auth', 'blocking'),
            (go_package_call(content, 'github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials',
                             'NewStaticCredentialsProvider'), 2, 'static_credential_provider', 'blocking'),
        ]
        default = go_package_call(content, 'github.com/aliyun/credentials-go/credentials', 'NewCredential')
        hmac_call = re.compile(r'\bhmac\s*\.\s*New\s*\(')
    else:
        rules = [(java_constructor(content, 'com.aliyun.oss.common.auth.DefaultCredentialProvider'),
                  2, 'static_credential_provider', 'blocking')]
        default = java_constructor(content, 'com.aliyun.credentials.Client')
        hmac_call = re.compile(r'\bMac\s*\.\s*getInstance\s*\(')
    # HMAC alone is often a payment signature. An OSS Authorization header is
    # required before surfacing this file as a manual cloud-signing candidate.
    hmac_present = any(iter_call_arguments(strip_comments(content), hmac_call))
    header = re.compile(r'\.\s*(?:Set|setRequestProperty)\s*\(')
    for line, code in iter_code_units(content):
        for constructor, minimum, kind, severity in rules:
            if any(len(args) >= minimum for args in iter_call_arguments(code, constructor)):
                yield dict(line=line, kind=kind, severity=severity)
        if any(not args or (language == 'go' and args == ['nil'])
               for args in iter_call_arguments(code, default)):
            yield dict(line=line, kind='default_credential_chain', severity='warning')
        if hmac_present and any(len(args) >= 2 and args[0] == '"Authorization"'
                                and re.match(r'^"OSS +', args[1])
                                for args in iter_call_arguments(code, header)):
            yield dict(line=line, kind='manual_oss_signer', severity='warning')


def iter_call_arguments(code, callee):
    """Yield outer arguments for each matched callee, balancing nested delimiters.

    callee must match through the opening parenthesis. Literal contents, escaped
    quotes and Go raw strings cannot introduce argument separators.
    """
    masked = list(code)
    cursor = 0
    while cursor < len(code):
        if code[cursor] in ('"', "'", '`'):
            end = quoted_end(code, cursor)
            masked[cursor:end] = ' ' * (end - cursor)
            cursor = end
        else:
            cursor += 1
    for match in callee.finditer(''.join(masked)):
        stack = ['(']
        args = []
        start = match.end()
        index = start
        while index < len(code):
            char = code[index]
            if char in ('"', "'", '`'):
                index = quoted_end(code, index)
                continue
            if char in '([{':
                stack.append(char)
            elif char in ')]}':
                if not stack or stack[-1] != {')': '(', ']': '[', '}': '{'}[char]:
                    break
                stack.pop()
                if not stack:
                    tail = code[start:index].strip()
                    if tail:
                        args.append(tail)
                    yield args
                    break
            elif char == ',' and len(stack) == 1:
                args.append(code[start:index].strip())
                start = index + 1
            index += 1

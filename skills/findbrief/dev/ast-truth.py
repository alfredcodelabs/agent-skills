"""Declaration truth from tree-sitter for bench.mjs --ast.

Development only. Needs Python with tree-sitter, tree-sitter-rust,
tree-sitter-python, tree-sitter-javascript, tree-sitter-java and, optionally,
tree-sitter-typescript. Run from the repository root:
    python3 .agents/skills/findbrief/dev/ast-truth.py > truth.json
"""
import json
import subprocess
import sys

import tree_sitter as ts
import tree_sitter_java
import tree_sitter_javascript
import tree_sitter_python
import tree_sitter_rust

try:
    import tree_sitter_typescript
except ImportError:
    tree_sitter_typescript = None

MAX_FILE_BYTES = 512 * 1024
JS_FAMILY = ('js', 'ts', 'tsx')
TOP_LEVEL = ('program', 'export_statement')
IMPL_TYPE_WRAPPERS = (
    'generic_type',
    'scoped_type_identifier',
    'reference_type',
)
IMPL_TYPE_FIELD = ('generic_type', 'reference_type')
RAW_PREFIX = 'r#'

LANGUAGES = {
    'java': ts.Language(tree_sitter_java.language()),
    'rs': ts.Language(tree_sitter_rust.language()),
    'py': ts.Language(tree_sitter_python.language()),
    'js': ts.Language(tree_sitter_javascript.language()),
}
if tree_sitter_typescript:
    LANGUAGES['ts'] = ts.Language(
        tree_sitter_typescript.language_typescript())
    LANGUAGES['tsx'] = ts.Language(tree_sitter_typescript.language_tsx())

EXTENSIONS = {
    'java': 'java',
    'rs': 'rs',
    'py': 'py',
    'js': 'js',
    'mjs': 'js',
    'cjs': 'js',
    'jsx': 'js',
    'ts': 'ts',
    'tsx': 'tsx',
}

JS_DECLARATIONS = {
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'method_definition',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
}
JAVA_DECLARATIONS = {
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'annotation_type_declaration',
    'method_declaration',
    'constructor_declaration',
}
DECLARATIONS = {
    'rs': {
        'function_item',
        'function_signature_item',
        'struct_item',
        'enum_item',
        'trait_item',
        'type_item',
        'const_item',
        'static_item',
        'mod_item',
        'union_item',
        'macro_definition',
    },
    'py': {'function_definition', 'class_definition'},
    'js': JS_DECLARATIONS,
    'ts': JS_DECLARATIONS,
    'tsx': JS_DECLARATIONS,
    'java': JAVA_DECLARATIONS,
}

JS_OWNERS = {
    'class_declaration',
    'function_declaration',
    'method_definition',
    'interface_declaration',
    'enum_declaration',
    'generator_function_declaration',
}
OWNERS = {
    'rs': {
        'impl_item',
        'trait_item',
        'mod_item',
        'function_item',
        'struct_item',
        'enum_item',
        'union_item',
    },
    'py': {'class_definition', 'function_definition'},
    'js': JS_OWNERS,
    'ts': JS_OWNERS,
    'tsx': JS_OWNERS,
    'java': JAVA_DECLARATIONS,
}


def text(node, source):
    return source[node.start_byte:node.end_byte].decode('utf8', 'replace')


def impl_name(node, source):
    target = node.child_by_field_name('type')
    while target is not None and target.type in IMPL_TYPE_WRAPPERS:
        field = 'type' if target.type in IMPL_TYPE_FIELD else 'name'
        target = target.child_by_field_name(field)
    return text(target, source) if target is not None else None


def name_of(node, source):
    if node.type == 'impl_item':
        return impl_name(node, source)
    name_node = node.child_by_field_name('name')
    if name_node is None:
        return None
    name = text(name_node, source)
    return name[len(RAW_PREFIX):] if name.startswith(RAW_PREFIX) else name


def is_top_level_lexical(language, node):
    if language not in JS_FAMILY or node.type != 'lexical_declaration':
        return False
    parent = node.parent
    if parent is None or parent.type not in TOP_LEVEL:
        return False
    return parent.type == 'program' or parent.parent.type == 'program'


def top_level_variables(node, source):
    for child in node.children:
        if child.type != 'variable_declarator':
            continue
        name_node = child.child_by_field_name('name')
        if name_node.type == 'identifier':
            yield {
                'name': text(name_node, source),
                'line': child.start_point[0] + 1,
                'owner': None,
            }


def walk(language, node, source, owner, found):
    if node.type in DECLARATIONS[language]:
        name = name_of(node, source)
        if name:
            line = node.child_by_field_name('name').start_point[0] + 1
            found.append({'name': name, 'line': line, 'owner': owner})
    if is_top_level_lexical(language, node):
        found.extend(top_level_variables(node, source))
    if node.type in OWNERS[language]:
        inner = name_of(node, source)
    else:
        inner = owner
    for child in node.children:
        walk(language, child, source, inner, found)


def language_of(file):
    if '.' not in file:
        return None
    return EXTENSIONS.get(file.rsplit('.', 1)[-1])


def declarations(file, language):
    with open(file, 'rb') as handle:
        source = handle.read()
    if len(source) > MAX_FILE_BYTES:
        return None
    tree = ts.Parser(LANGUAGES[language]).parse(source)
    found = []
    walk(language, tree.root_node, source, None, found)
    return {
        'lang': language,
        'errors': tree.root_node.has_error,
        'decls': found,
    }


def main():
    listing = subprocess.run(
        ['git', 'ls-files'], capture_output=True, text=True, check=True)
    result = {}
    for file in listing.stdout.split('\n'):
        language = language_of(file)
        if not language or language not in LANGUAGES:
            continue
        entry = declarations(file, language)
        if entry is not None:
            result[file] = entry
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()

import test from "node:test";
import assert from "node:assert/strict";
import { symbols } from "../scripts/symbols.mjs";

const names = (file, text) =>
  symbols(file, text).map((s) => [s.kind, s.owner ? `${s.owner}::${s.name}` : s.name, s.line]);

test("rust: comments, strings and lifetimes never declare anything", () => {
  const text = [
    "// fn phantom_from_comment() {}",
    "/* outer /* nested fn phantom_nested() */ still comment fn phantom_tail() */",
    'const S: &str = "fn phantom_from_string() {}";',
    'const R: &str = r#"fn phantom_raw() { "quoted" }"#;',
    "fn real<'a>(x: &'a str) -> char { 'x' }",
    "fn quote() -> char { '\\'' }",
    "impl Quoted { fn byte(b: u8) -> bool { matches!(b, b'\\'' | b'{') } fn inside(&self) {} }",
    "fn after_quote() {}",
    "fn random<const N: usize>(p: *const u8, q: *mut u8) -> [u8; N] { [0; N] }",
  ].join("\n");
  assert.deepEqual(names("a.rs", text), [
    ["const", "S", 3],
    ["const", "R", 4],
    ["fn", "real", 5],
    ["fn", "quote", 6],
    ["fn", "Quoted::byte", 7],
    ["fn", "Quoted::inside", 7],
    ["fn", "after_quote", 8],
    ["fn", "random", 9],
  ]);
});

test("rust: raw identifiers, unicode names and keyword-like names are declarations", () => {
  const text =
    "fn r#type() {}\nfn función() {}\nfn function() {}\npub(crate) async unsafe fn go() {}\nstatic mut COUNT: u8 = 0;\nmacro_rules! m { () => {} }\n";
  assert.deepEqual(names("a.rs", text), [
    ["fn", "type", 1],
    ["fn", "función", 2],
    ["fn", "function", 3],
    ["fn", "go", 4],
    ["static", "COUNT", 5],
    ["macro", "m", 6],
  ]);
});

test("rust: impl blocks own their methods, including generic trait impls", () => {
  const text = [
    "struct Alpha;",
    "impl Alpha {",
    "    fn route(&self) {}",
    "}",
    "impl<T: Clone> fmt::Display for Beta<T> where T: Fn() -> u8 {",
    "    fn route(&self) {}",
    "}",
    "mod tests {",
    "    fn helper() { let f = |x: u8| { x }; }",
    "}",
    "fn free() {}",
  ].join("\n");
  assert.deepEqual(names("a.rs", text), [
    ["struct", "Alpha", 1],
    ["fn", "Alpha::route", 3],
    ["fn", "Beta::route", 6],
    ["mod", "tests", 8],
    ["fn", "tests::helper", 9],
    ["fn", "free", 11],
  ]);
});

test("python: async functions, methods by indentation and strings that look like code", () => {
  const text = [
    '"""def phantom_doc(): pass"""',
    "class Store:",
    "    async def load(self):",
    "        s = 'def phantom_string(): pass'",
    "        # def phantom_comment(): pass",
    "    def save(self, x=(1,",
    "                     2)):",
    "        pass",
    "",
    "async def main():",
    "    pass",
  ].join("\n");
  assert.deepEqual(names("a.py", text), [
    ["class", "Store", 2],
    ["def", "Store::load", 3],
    ["def", "Store::save", 6],
    ["def", "main", 10],
  ]);
});

test("javascript: templates, regular expressions and divisions keep the lexer in code", () => {
  const text = [
    "const tpl = `function phantom_tpl() {} ${ { a: 1 }.a } more`;",
    "const re = /function phantom_re\\(\\) \\{/g;",
    "const half = 1 / 2; function afterDivision() {}",
    "export class Panel extends Base {",
    "  render(props) {",
    "    if (props) { return h(`x`); }",
    "  }",
    "  get size(): number {",
    "    return 1;",
    "  }",
    "}",
    'import type Foo from "./foo";',
    "export interface Shape { area(): number }",
    "export const hook = { useHook: () => function useHook() {}, fetch: async function load() {} }",
    'import { type Hidden, Shown } from "./x"; export type Alias<T> = T',
    "function noSemicolons() {}",
    "function afterAsi() {}",
    "class Failure extends Error {",
    "  data: any",
    "  constructor(msg: string) { super(msg) }",
    "}",
  ].join("\n");
  assert.deepEqual(names("a.ts", text), [
    ["const", "tpl", 1],
    ["const", "re", 2],
    ["function", "afterDivision", 3],
    ["const", "half", 3],
    ["class", "Panel", 4],
    ["fn", "Panel::render", 5],
    ["fn", "Panel::size", 8],
    ["interface", "Shape", 13],
    ["const", "hook", 14],
    ["type", "Alias", 15],
    ["function", "noSemicolons", 16],
    ["function", "afterAsi", 17],
    ["class", "Failure", 18],
    ["fn", "Failure::constructor", 20],
  ]);
});

test("java: methods after their return type, constructors, nested types and text blocks", () => {
  const text = [
    "/* class Phantom {} */",
    "public final class Store<T> extends Base {",
    '  private static final String Q = "class Fake { void no() {} }";',
    "  Store() { super(); }",
    "  @Override public <R> List<R> map(Function<T, R> f) throws IOException { return items.map(f); }",
    "  void run() { helper(1); Runnable r = new Runnable() { public void tick() {} }; }",
    "  interface Listener { void onEvent(String e); }",
    '  String text = """',
    "     class InsideTextBlock { }",
    '     """;',
    "}",
  ].join("\n");
  assert.deepEqual(names("Store.java", text), [
    ["class", "Store", 2],
    ["fn", "Store::Store", 4],
    ["fn", "Store::map", 5],
    ["fn", "Store::run", 6],
    ["fn", "run::tick", 6],
    ["interface", "Store::Listener", 7],
    ["fn", "Listener::onEvent", 7],
  ]);
});

test("names that exist on every JavaScript object are not keywords or languages", () => {
  assert.deepEqual(names("a.ts", 'class A {\n  constructor() {}\n  toString() { return "" }\n}'), [
    ["class", "A", 1],
    ["fn", "A::constructor", 2],
    ["fn", "A::toString", 3],
  ]);
  assert.deepEqual(symbols("notes.constructor", "fn x() {}"), []);
  assert.deepEqual(symbols("weird.__proto__", "fn x() {}"), []);
});

test("every Unicode space separates tokens instead of stopping the lexer", () => {
  assert.deepEqual(
    names("a.ts", "const x = 1;\u00a0const y = 2;\n").map((s) => s[1]),
    ["x", "y"],
  );
  assert.deepEqual(
    names("a.rs", "fn a() {}\u2028fn b() {}\u3000fn c() {}\n").map((s) => s[1]),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    names("a.py", "\ufeffdef a():\u000b pass\ndef b(): pass\n").map((s) => s[1]),
    ["a", "b"],
  );
});

test("signature-position impl Trait, generic methods, both shell forms and combining marks", () => {
  assert.deepEqual(names("a.rs", "fn maker() -> impl Fn() {\n    fn nested() {}\n    || ()\n}\nfn take(x: impl Into<u8>) {}\n"), [
    ["fn", "maker", 1],
    ["fn", "maker::nested", 2],
    ["fn", "take", 5],
  ]);
  assert.deepEqual(names("a.ts", "class Box { unwrap<T>(value: T): T { return value; } }\n"), [
    ["class", "Box", 1],
    ["fn", "Box::unwrap", 1],
  ]);
  assert.deepEqual(names("a.sh", "function real_shell { :; }\n  indented_shell() { :; }\n").map((s) => s[1]), ["real_shell", "indented_shell"]);
  assert.deepEqual(names("a.py", "def cafe\u0301():\n    pass\n").map((s) => s[1]), ["cafe\u0301"]);
});

test("go: top-level funcs, methods by receiver, types, consts and vars, including grouped blocks", () => {
  const text = [
    "package admin",
    "",
    "import (",
    "\t\"context\"",
    ")",
    "",
    "var (",
    "\tErrNotFound = errors.New(\"x\")",
    "\t// a comment is not a declaration",
    "\t_ = unused",
    "\tlimit, burst = 1, 2",
    ")",
    "",
    "const PropagationWindow = 6 * time.Minute",
    "",
    "type (",
    "\tState string",
    "\tKey struct {",
    "\t\tID string",
    "\t}",
    ")",
    "",
    "type SigningKeyAdmin struct {",
    "\tkeys Repository",
    "}",
    "",
    "var _ Port = (*SigningKeyAdmin)(nil)",
    "",
    "func NewSigningKeyAdmin(keys Repository) *SigningKeyAdmin {",
    "\treturn &SigningKeyAdmin{keys: keys}",
    "}",
    "",
    "func (a *SigningKeyAdmin) Rotate(ctx context.Context) error { return nil }",
    "func (Set[T]) Add(v T) {}",
    "func Map[T, U any](in []T) []U { return nil }",
    "\tfunc nested() {}",
  ].join("\n");
  assert.deepEqual(names("a.go", text), [
    ["var", "ErrNotFound", 8],
    ["var", "limit", 11],
    ["const", "PropagationWindow", 14],
    ["type", "State", 17],
    ["type", "Key", 18],
    ["type", "SigningKeyAdmin", 23],
    ["fn", "NewSigningKeyAdmin", 29],
    ["fn", "SigningKeyAdmin::Rotate", 33],
    ["fn", "Set::Add", 34],
    ["fn", "Map", 35],
  ]);
});

test("go: a raw string inside a grouped block never closes the group", () => {
  const text = [
    "const (",
    "\tinsertAudit = `",
    "INSERT INTO audits (",
    "  id",
    ") VALUES ($1)`",
    "",
    "\tnextVersion = `",
    "SELECT 1`",
    ")",
    "",
    "type Repository struct{}",
  ].join("\n");
  assert.deepEqual(names("a.go", text), [
    ["const", "insertAudit", 2],
    ["const", "nextVersion", 7],
    ["type", "Repository", 11],
  ]);
});

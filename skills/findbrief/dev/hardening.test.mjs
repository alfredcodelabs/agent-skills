import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FindbriefError } from "../scripts/config.mjs";
import { ignoreRules, ignoreVerdict, runGit } from "../scripts/store.mjs";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const CLI = path.join(SCRIPTS, "findbrief.mjs");
const AUTHOR = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "hardening-repo-")),
    home = mkdtempSync(path.join(tmpdir(), "hardening-home-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git(...AUTHOR, "commit", "-q", "--allow-empty", "-m", message);
  };
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [options.cli ?? CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FINDBRIEF_HOME: home, ...options.env },
    });
    return { ...result, json: result.status === 0 && args.includes("--json") ? JSON.parse(result.stdout) : null };
  };
  git("init", "-q", "-b", "main");
  write("src/queue.rs", "pub struct QueueArn;\n");
  commit("feat: add queue");
  return { root, home, git, write, commit, run, cleanup: () => [root, home].forEach((dir) => rmSync(dir, { recursive: true, force: true })) };
}

const finishesWithin = (milliseconds, source) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: milliseconds });

test("git configuration inside the repository cannot run commands", () => {
  const r = repository(), markers = mkdtempSync(path.join(tmpdir(), "hardening-markers-"));
  const marker = (name) => path.join(markers, name);
  try {
    const hooks = path.join(markers, "hooks");
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, "post-index-change"), `#!/bin/sh\ntouch '${marker("hook")}'\n`);
    chmodSync(path.join(hooks, "post-index-change"), 0o755);
    r.write(".gitattributes", "*.rs filter=evil\n*.txt filter=ev=il\n*.md filter=included\n");
    r.write("notes.txt", "plain\n");
    r.write("README.md", "# Notes\n");
    r.commit("chore: attributes");
    r.git("config", "core.fsmonitor", `touch '${marker("fsmonitor")}'; false`);
    r.git("config", "core.hooksPath", hooks);
    r.git("config", "filter.evil.clean", `touch '${marker("clean")}'; cat`);
    r.git("config", "filter.evil.required", "true");
    r.git("config", "filter.ev=il.process", `touch '${marker("process")}'`);
    writeFileSync(path.join(markers, "included.config"), `[filter "included"]\n\tclean = touch '${marker("included")}'; cat\n`);
    r.git("config", "include.path", path.join(markers, "included.config"));
    const past = new Date(Date.now() - 3600 * 1000);
    utimesSync(path.join(r.root, "src/queue.rs"), past, past);
    utimesSync(path.join(r.root, "notes.txt"), past, past);
    utimesSync(path.join(r.root, "README.md"), past, past);
    const result = r.run(["why", "QueueArn", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.definitions[0].file, "src/queue.rs");
    assert.deepEqual(
      ["fsmonitor", "hook", "clean", "process", "included"].filter((name) => existsSync(marker(name))),
      [],
    );
  } finally {
    r.cleanup();
    rmSync(markers, { recursive: true, force: true });
  }
});

test("invalid .briefignore patterns are dropped instead of breaking every command", () => {
  const rules = ignoreRules("a[b\n[z-a]\n[[:nope:]]x\nvendor/\n");
  assert.deepEqual(
    ["a[b", "z", "a", "vendor/x.rs", "src/main.rs"].map((file) => ignoreVerdict(rules, file)),
    [null, null, null, "exclude", null],
  );
  const r = repository();
  try {
    r.write(".briefignore", "a[b\n[z-a]\n");
    const result = r.run(["find", "QueueArn", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json[0].file, "src/queue.rs");
  } finally {
    r.cleanup();
  }
});

test("commit messages with any separator character are indexed", () => {
  const r = repository();
  try {
    r.commit("fix: separators\n\nbody\x1epart /0123456789012345678901234567890123456789\x1f");
    r.commit("/0123456789012345678901234567890123456789");
    const index = r.run(["index", "--json"]);
    assert.equal(index.status, 0, index.stderr);
    assert.equal(index.json.commits, 3);
    assert.equal(r.run(["when", "separators", "--json"]).json[0].subject, "fix: separators");
    assert.deepEqual(
      r.run(["why", "src/queue.rs", "--json"]).json.commits.map((commit) => commit.subject),
      ["feat: add queue"],
    );
  } finally {
    r.cleanup();
  }
});

test(".briefignore globs match in linear time with gitignore semantics", () => {
  const store = pathToFileURL(path.join(SCRIPTS, "store.mjs")).href;
  const result = finishesWithin(
    5000,
    `import { ignoreRules, ignoreVerdict } from ${JSON.stringify(store)};
    const rules = ignoreRules("*a*a*a*a*a*a*a*a*a*a*b\\n/x/**/a*a*a*a*a*a*a*a*c\\n");
    const name = "a".repeat(200);
    if (ignoreVerdict(rules, name) !== null || ignoreVerdict(rules, "x/" + "y/".repeat(50) + name) !== null) { process.exit(3); }`,
  );
  assert.equal(result.status, 0, result.stderr || String(result.signal));
  const rules = ignoreRules("/build\n**/gen/**\n!/keep/**\nlogs/\n!logs/keep.md\na\\*b\n!.notes/**/*.md\n*.[ch]\n");
  assert.deepEqual(
    ["build/x", "src/build", "a/gen/b", "gen", "keep/x", "logs/keep.md", "a*b", "axb", ".notes/a/b.md", "x/y.c", "x/y.o"].map((file) =>
      ignoreVerdict(rules, file),
    ),
    ["exclude", null, "exclude", null, "include", "exclude", "exclude", null, "include", "exclude", null],
  );
});

test("symbol extraction stays fast on unbalanced code", () => {
  const symbolsModule = pathToFileURL(path.join(SCRIPTS, "symbols.mjs")).href;
  const result = finishesWithin(
    10000,
    `import { symbols } from ${JSON.stringify(symbolsModule)};
    const cap = 512 * 1024;
    for (const [file, unit] of [["a.js", "a(\\n"], ["a.rs", "impl X\\n"], ["A.java", "void a() throws X\\n"], ["a.ts", "a(): x\\n"], ["a.rs", "{fn a(){}"], ["a.md", "# a" + "#".repeat(1000)]]) {
      symbols(file, unit.repeat(Math.ceil(cap / unit.length)).slice(0, cap));
    }`,
  );
  assert.equal(result.status, 0, result.stderr || String(result.signal));
});

test("why on a symbol in an edited file falls back to the file history", () => {
  const r = repository();
  try {
    const clean = r.run(["why", "QueueArn", "--json"]).json.definitions[0];
    assert.equal(clean.note, undefined);
    assert.equal(clean.commits.length, 1);
    r.write("src/queue.rs", "pub struct QueueArn;\nfn beta() {}\n");
    const edited = r.run(["why", "beta", "--json"]);
    assert.equal(edited.status, 0, edited.stderr);
    assert.deepEqual(edited.json.definitions[0].commits.map((commit) => commit.subject), ["feat: add queue"]);
    assert.ok(edited.json.definitions[0].note);
    assert.match(r.run(["why", "beta"]).stdout, /fn beta at src\/queue\.rs:2\n {2}\S.*\n {2}\d{4}-\d\d-\d\d \w+ feat: add queue/);
    r.write("src/draft.rs", "fn gamma() {}\n");
    assert.equal(r.run(["why", "gamma"]).status, 0);
  } finally {
    r.cleanup();
  }
});

test("file names with newlines, quotes and non-ASCII characters are indexed", () => {
  const r = repository();
  try {
    r.write("año.rs", "pub struct SpanishYear;\n");
    r.commit("feat: add year");
    r.write('"quoted.rs', "pub struct QuotedName;\n");
    r.write("new\nline.rs", "pub struct NewlineName;\n");
    r.write("carriage\r", "#!/bin/sh\nreturned() { :; }\n");
    for (const [name, file] of [["SpanishYear", "año.rs"], ["QuotedName", '"quoted.rs'], ["NewlineName", "new\nline.rs"], ["returned", "carriage\r"]]) {
      const result = r.run(["find", name, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json[0]?.file, file);
    }
    assert.deepEqual(
      r.run(["why", "año.rs", "--json"]).json.commits.map((commit) => commit.subject),
      ["feat: add year"],
    );
  } finally {
    r.cleanup();
  }
});

test("the command line works from a directory with spaces and non-ASCII characters", () => {
  const r = repository(), place = mkdtempSync(path.join(tmpdir(), "hardening skill ñ-"));
  try {
    cpSync(SCRIPTS, path.join(place, "scripts"), { recursive: true });
    const result = r.run(["find", "QueueArn"], { cli: path.join(place, "scripts", "findbrief.mjs") });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /src\/queue\.rs/);
  } finally {
    r.cleanup();
    rmSync(place, { recursive: true, force: true });
  }
});

test("include rules that point outside the repository are ignored", () => {
  const r = repository();
  try {
    r.write(".briefignore", "!../../etc/\n!/../x/*.md\n!//etc/\n");
    const result = r.run(["find", "QueueArn", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json[0].file, "src/queue.rs");
  } finally {
    r.cleanup();
  }
});

test("a missing git or oversized git output is a clear error", () => {
  const r = repository();
  try {
    const result = r.run(["brief"], { env: { PATH: path.join(r.home, "no-such-bin") } });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^findbrief: git is not installed or not on PATH\n$/);
  } finally {
    r.cleanup();
  }
  const failing = (code) => ({ git: () => ({ error: Object.assign(new Error(`spawnSync git ${code}`), { code }), status: null, stdout: null, stderr: null }) });
  assert.throws(
    () => runGit(failing("ENOBUFS"), "/", ["log"]),
    (error) => error instanceof FindbriefError && /^git log: output exceeds \d+ bytes$/.test(error.message),
  );
  assert.throws(
    () => runGit(failing("EACCES"), "/", ["status"]),
    (error) => error instanceof FindbriefError && error.message === "git status: spawnSync git EACCES",
  );
});

test("a relative XDG_CACHE_HOME is ignored and the index goes to ~/.cache", () => {
  const r = repository(), home = mkdtempSync(path.join(tmpdir(), "hardening-user-"));
  try {
    const environment = { ...process.env, HOME: home, XDG_CACHE_HOME: "relative-cache" };
    delete environment.FINDBRIEF_HOME;
    const result = spawnSync(process.execPath, [CLI, "find", "QueueArn"], { cwd: r.root, encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(path.join(r.root, "relative-cache")));
    assert.ok(existsSync(path.join(home, ".cache", "findbrief")));
  } finally {
    r.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown options are an error instead of being dropped from the query", () => {
  const r = repository();
  try {
    const unknown = r.run(["find", "QueueArn", "--limit", "3"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^findbrief: --limit is not an option; usage: /);
    const known = r.run(["find", "-n", "1", "QueueArn", "--budget", "900", "--json"]);
    assert.equal(known.status, 0, known.stderr);
    assert.deepEqual(known.json.map((match) => match.file), ["src/queue.rs"]);
  } finally {
    r.cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  exactTokens,
  fit,
  ignoreRules,
  ignoreVerdict,
  symbols,
  terms,
  words,
} from "../scripts/findbrief.mjs";
import { score } from "./bench.mjs";
import { withTextLines } from "../scripts/rank.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "findbrief.mjs");

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "context-repo-")),
    home = mkdtempSync(path.join(tmpdir(), "context-home-"));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const commit = (message, date) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message, "--date", date);
  };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FINDBRIEF_HOME: home, GIT_COMMITTER_DATE: "" },
    });
    return { ...r, json: r.status === 0 && args.includes("--json") ? JSON.parse(r.stdout) : null };
  };
  git("init", "-q", "-b", "main");
  write(
    "crates/sqs/src/arn.rs",
    "pub struct QueueArn { pub name: String }\npub fn parse_queue_arn(raw: &str) -> QueueArn { todo!() }\n",
  );
  write(
    "crates/sqs/src/service.rs",
    'use crate::arn::QueueArn;\npub fn create_queue() -> QueueArn { parse_queue_arn("x") }\n',
  );
  write("crates/s3/src/bucket.rs", "pub struct BucketPolicy;\n");
  write("docs/SETUP.md", "# Setup\n\n## Queues\nQueues use QueueArn values.\n");
  commit("feat(sqs): add queue ARNs\n\nQueues need stable ARNs for policies.", "2026-01-01T00:00:00Z");
  write(
    "crates/sqs/src/arn.rs",
    "pub struct QueueArn { pub name: String, pub region: String }\npub fn parse_queue_arn(raw: &str) -> QueueArn { todo!() }\n",
  );
  write(
    "crates/sqs/src/service.rs",
    'use crate::arn::QueueArn;\npub fn create_queue() -> QueueArn { parse_queue_arn("y") }\n',
  );
  commit("fix(sqs): keep the region in queue ARNs\n\nCross-region ARNs were rejected.", "2026-02-01T00:00:00Z");
  return {
    root,
    home,
    write,
    commit,
    run,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("identifiers split the same way in the index and in queries", () => {
  assert.equal(words("SqsArn parse_queue_arn HTTPServer"), "sqs arn parse_queue_arn http server");
});

test("symbol extraction covers the languages in the repository with lines", () => {
  assert.deepEqual(
    symbols("a.rs", "pub(crate) async fn go() {}\nstruct A;\nmacro_rules! m { () => {} }\n").map((s) => [
      s.kind,
      s.name,
      s.line,
    ]),
    [
      ["fn", "go", 1],
      ["struct", "A", 2],
      ["macro", "m", 3],
    ],
  );
  assert.deepEqual(
    symbols("a.mjs", "export function f() {}\nclass K {\n  method(a) {\n  if (x) {\n}\n").map((s) => s.name),
    ["f", "K", "method"],
  );
  assert.deepEqual(
    symbols("a.md", "# Title\ntext\n## Part two ##\n").map((s) => [s.kind, s.name]),
    [
      ["h1", "Title"],
      ["h2", "Part two"],
    ],
  );
  assert.deepEqual(
    symbols("tool", "#!/usr/bin/env python3\ndef main():\n").map((s) => s.name),
    ["main"],
  );
});

test("find ranks the defining file first and explains each result", () => {
  const r = repo();
  try {
    const { json } = r.run("find", "queue", "arn", "--json");
    assert.equal(json[0].file, "crates/sqs/src/arn.rs");
    assert.match(json[0].reason, /QueueArn:1/);
    assert.ok(json.every((x) => /^(defines|matches text|path matches)/.test(x.reason)), JSON.stringify(json));
  } finally {
    r.cleanup();
  }
});

test("output is identical across runs and after rebuilding the index", () => {
  const r = repo();
  try {
    const first = r.run("find", "queue", "region", "--json").stdout;
    assert.equal(r.run("find", "queue", "region", "--json").stdout, first);
    rmSync(r.home, { recursive: true, force: true });
    assert.equal(r.run("find", "queue", "region", "--json").stdout, first);
  } finally {
    r.cleanup();
  }
});

test("an index updated across commits answers exactly like a fresh index of the same tree", () => {
  const r = repo(), fresh = mkdtempSync(path.join(tmpdir(), "context-fresh-"));
  const size = 40, areas = ["queue", "topic", "bucket", "table", "stream"];
  const service = (i, extra = "") => {
    const area = areas[i % areas.length];
    const calls = [1, 2, 3].map((k) => `${areas[(i * k + 1) % areas.length]}_handler_${(i * 7 * k + 3) % size}();`).join(" ");
    return `pub struct ${area}Part${i};\npub fn ${area}_handler_${i}() { ${calls} Shared${i % 6}::new(); }\n// ${area} ${"bucket ".repeat(i % 4)}policy\n${extra}`;
  };
  const write = (from, to, extra) => {
    for (let i = from; i < to; i++) {
      r.write(`svc/${areas[i % areas.length]}/m${i}.rs`, service(i, extra));
    }
  };
  const freshRun = (...args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: r.root, encoding: "utf8", env: { ...process.env, FINDBRIEF_HOME: fresh } });
  try {
    write(size / 2, size);
    for (let i = 0; i < 6; i++) {
      r.write(`zz/shared${i}.rs`, `pub struct Shared${i};\n`);
    }
    r.commit("feat: add the second half of the services", "2026-03-01T00:00:00Z");
    r.run("index");
    write(0, size / 2);
    r.commit("feat: add the first half of the services", "2026-03-02T00:00:00Z");
    r.run("index");
    for (let i = 25; i < 30; i++) {
      rmSync(path.join(r.root, `svc/${areas[i % areas.length]}/m${i}.rs`));
    }
    write(0, 10, "// queue bucket policy\n");
    r.commit("fix: bucket policy for queues", "2026-03-03T00:00:00Z");
    r.run("index");
    write(25, 30, "// restored\n");
    r.write("docs/notes.md", "# Queue bucket policy\nqueue topic bucket\n");
    r.commit("feat: restore table streams", "2026-03-04T00:00:00Z");
    r.run("index");
    r.write("svc/queue/m5.rs", service(5, "// edited bucket\n"));
    r.write("svc/new/draft.rs", "pub fn queue_draft() { queue_handler_0(); }\n");
    const calls = [
      ["find", "queue", "bucket", "policy", "--json"],
      ["find", "topic", "handler", "-n", "30", "--json"],
      ["find", "stream", "table", "-n", "30"],
      ["find", "Shared3"],
      ["brief"],
      ["why", "svc/queue/m0.rs"],
      ["why", "queuePart5"],
    ];
    for (const call of calls) {
      const updated = r.run(...call), rebuilt = freshRun(...call);
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(updated.stdout, rebuilt.stdout, call.join(" "));
    }
  } finally {
    r.cleanup();
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("why follows a file and a symbol through history; when searches commit messages", () => {
  const r = repo();
  try {
    const file = r.run("why", "crates/sqs/src/arn.rs", "--json").json;
    assert.deepEqual(
      file.commits.map((c) => c.subject),
      ["fix(sqs): keep the region in queue ARNs", "feat(sqs): add queue ARNs"],
    );
    assert.deepEqual(
      file.cochanged.map((c) => [c.path, c.n]),
      [
        ["crates/sqs/src/service.rs", "2"],
        ["crates/s3/src/bucket.rs", "1"],
        ["docs/SETUP.md", "1"],
      ],
    );
    const symbol = r.run("why", "QueueArn", "--json").json;
    assert.equal(symbol.definitions[0].file, "crates/sqs/src/arn.rs");
    assert.equal(symbol.definitions[0].commits.length, 2);
    const fixes = r.run("when", "region", "--type", "fix", "--json").json;
    assert.deepEqual(
      fixes.map((c) => c.subject),
      ["fix(sqs): keep the region in queue ARNs"],
    );
    assert.match(r.run("why", "crates/sqs/src/arn.rs").stdout, /Cross-region ARNs were rejected/);
    assert.equal(r.run("why", "NoSuchThing").status, 2);
  } finally {
    r.cleanup();
  }
});

test("the index follows edits, new files, deletions and new commits without a rebuild", () => {
  const r = repo();
  try {
    assert.equal(r.run("index", "--json").json.files, 4);
    r.write("crates/sns/src/topic.rs", "pub struct TopicFanout;\n");
    assert.equal(r.run("find", "topic", "fanout", "--json").json[0].file, "crates/sns/src/topic.rs");
    rmSync(path.join(r.root, "crates/s3/src/bucket.rs"));
    assert.ok(!r.run("find", "bucket", "policy", "--json").json.some((x) => x.file === "crates/s3/src/bucket.rs"));
    r.commit("feat(sns): add topic fanout", "2026-03-01T00:00:00Z");
    const index = r.run("index", "--json").json;
    assert.deepEqual([index.files, index.commits], [4, 3]);
    assert.equal(r.run("when", "fanout", "--json").json[0].subject, "feat(sns): add topic fanout");
  } finally {
    r.cleanup();
  }
});

test("brief stays within its budget and names areas and recent commits", () => {
  const r = repo();
  try {
    const out = r.run("brief", "--budget", "2000").stdout;
    assert.ok(out.length <= 2000);
    assert.match(out, /- crates \[3\]/);
    assert.match(out, /fix\(sqs\): keep the region/);
  } finally {
    r.cleanup();
  }
});

test("stop words are dropped unless the query has nothing else", () => {
  assert.deepEqual(terms("add support for the queue ARN"), ["queue", "arn"]);
  assert.deepEqual(terms("add the"), ["add", "the"]);
});

test("plural and verb forms find the same files", () => {
  const r = repo();
  try {
    assert.equal(r.run("find", "queues", "arns", "--json").json[0].file, "crates/sqs/src/arn.rs");
    assert.equal(
      r.run("when", "keeping", "regions", "--json").json[0].subject,
      "fix(sqs): keep the region in queue ARNs",
    );
  } finally {
    r.cleanup();
  }
});

test("benchmark metrics reward the first correct file", () => {
  assert.deepEqual(score(["a", "b"], ["a"]), { hit1: 1, r5: 1, mrr: 1 });
  assert.deepEqual(score(["x", "b", "a"], ["a", "b"]), { hit1: 0, r5: 1, mrr: 0.5 });
  assert.deepEqual(score([], ["a"]), { hit1: 0, r5: 0, mrr: 0 });
});

test("exact symbol names and paths rank first, acronyms and plain words stay text", () => {
  assert.deepEqual(exactTokens("BucketPolicy"), ["BucketPolicy"]);
  assert.deepEqual(exactTokens("fix S3 API for FilterRule and put_object in crates/s3/src/lib.rs"), [
    "FilterRule",
    "put_object",
    "crates/s3/src/lib.rs",
  ]);
  assert.deepEqual(exactTokens("support Lambda streams"), []);
  const r = repo();
  try {
    r.write(
      "crates/sqs/src/users.rs",
      "use crate::arn::QueueArn;\n// QueueArn QueueArn QueueArn queue arn queue arn\n",
    );
    assert.deepEqual(
      r
        .run("find", "QueueArn", "--json")
        .json.slice(0, 1)
        .map((x) => [x.file, x.reason]),
      [["crates/sqs/src/arn.rs", "defines QueueArn:1"]],
    );
    assert.equal(r.run("find", "region", "service.rs", "--json").json[0].file, "crates/sqs/src/service.rs");
  } finally {
    r.cleanup();
  }
});

test("text output is cut on a whole line within the budget", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const cut = fit(text, 100);
  assert.ok(cut.length <= 100);
  assert.match(cut, /^line 0\n[\s\S]*\n… truncated/);
  assert.equal(fit("short\n", 100), "short\n");
});

test("concurrent refreshes of a changed index all succeed", async () => {
  const r = repo();
  try {
    r.run("index");
    const call = () =>
      new Promise((done) => {
        const child = spawn(process.execPath, [CLI, "find", "queue", "--json"], {
          cwd: r.root,
          env: { ...process.env, FINDBRIEF_HOME: r.home },
        });
        let err = "";
        child.stderr.on("data", (d) => {
          err += d;
        });
        child.on("close", (code) => done({ code, err }));
      });
    for (let round = 0; round < 3; round++) {
      r.write("crates/sqs/src/change.rs", `pub fn contention_${round}() {}\n`);
      const runs = await Promise.all(Array.from({ length: 6 }, call));
      assert.deepEqual(
        runs.filter((x) => x.code !== 0),
        [],
      );
    }
  } finally {
    r.cleanup();
  }
});

test("equal candidates keep the same order after an edit is reverted", () => {
  const r = repo();
  try {
    for (let i = 0; i < 110; i++) {
      r.write(`eq/a${String(i).padStart(3, "0")}.rs`, "pub fn common_lookup() {}\n");
    }
    r.commit("feat: add equal candidates", "2026-03-01T00:00:00Z");
    const before = r.run("find", "common_lookup", "shared", "--json").stdout;
    r.write("eq/a000.rs", "pub fn common_lookup() {}\n// temporary\n");
    r.run("index");
    r.write("eq/a000.rs", "pub fn common_lookup() {}\n");
    assert.equal(r.run("find", "common_lookup", "shared", "--json").stdout, before);
    assert.equal(JSON.parse(before)[0].file, "eq/a000.rs");
  } finally {
    r.cleanup();
  }
});

test("symbolic links are not followed out of the repository", () => {
  const r = repo(),
    outside = mkdtempSync(path.join(tmpdir(), "context-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.rs"), "pub fn leaked_secret_marker() {}\n");
    symlinkSync(path.join(outside, "secret.rs"), path.join(r.root, "linked.rs"));
    assert.deepEqual(r.run("find", "leaked_secret_marker", "--json").json, []);
  } finally {
    r.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test(".briefignore follows gitignore syntax and brings back ignored notes at lower weight", () => {
  const rules = ignoreRules("# scope\nvendor/\n*.min.js\n/build\n!.notes/**/*.md\n");
  assert.deepEqual(
    ["vendor/a.rs", "x/vendor/b.rs", "app.min.js", "build/o.rs", "src/build/o.rs", ".notes/a/b.md", "src/main.rs"].map(
      (f) => ignoreVerdict(rules, f),
    ),
    ["exclude", "exclude", "exclude", "exclude", null, "include", null],
  );
  const r = repo();
  try {
    r.write(".gitignore", ".notes/\n");
    r.write("vendor/queue.rs", "pub struct VendoredQueueArn;\n");
    r.write(".notes/plan/queue.md", "# Queue ARN plan\nqueue arn queue arn region\n");
    r.write(".briefignore", "vendor/\n!.notes/**/*.md\n");
    const files = r.run("find", "queue", "arn", "-n", "20", "--json").json.map((x) => x.file);
    assert.ok(!files.includes("vendor/queue.rs"));
    assert.ok(files.includes(".notes/plan/queue.md"));
    assert.ok(files.indexOf(".notes/plan/queue.md") > files.indexOf("crates/sqs/src/arn.rs"));
  } finally {
    r.cleanup();
  }
});

test("brief groups files by the nearest module manifest", () => {
  const r = repo();
  try {
    r.write("crates/sqs/Cargo.toml", '[package]\nname = "sqs"\n');
    r.write("apps/web/package.json", "{}\n");
    r.write("apps/web/src/main.js", "export function start() {}\n");
    const text = r.run("brief").stdout;
    assert.match(text, /- crates\/sqs \[3\]/);
    assert.match(text, /- apps\/web \[2\]/);
    assert.match(text, /- crates \[1\]/);
  } finally {
    r.cleanup();
  }
});

test("paths resolve from the current directory, with ./ and absolute; unknown owners are not claimed", () => {
  const r = repo();
  try {
    const at = (cwd, ...args) =>
      JSON.parse(
        spawnSync(process.execPath, [CLI, ...args, "--json"], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, FINDBRIEF_HOME: r.home },
        }).stdout,
      );
    const sub = path.join(r.root, "crates/sqs/src");
    assert.equal(at(sub, "find", "arn.rs")[0].file, "crates/sqs/src/arn.rs");
    assert.equal(at(r.root, "find", "./crates/sqs/src/arn.rs")[0].file, "crates/sqs/src/arn.rs");
    assert.equal(at(r.root, "find", path.join(r.root, "crates/sqs/src/arn.rs"))[0].file, "crates/sqs/src/arn.rs");
    assert.equal(at(sub, "why", "./arn.rs").commits.length, 2);
    r.write(
      "crates/sqs/src/route.rs",
      "struct Alpha;\nimpl Alpha {\n    fn route() {}\n}\nstruct Beta;\nimpl Beta {\n    fn route() {}\n}\n",
    );
    assert.deepEqual(
      at(r.root, "find", "Beta::route")
        .slice(0, 1)
        .map((x) => x.reason),
      ["defines Beta::route:7"],
    );
    assert.deepEqual(
      at(r.root, "why", "Beta::route").definitions.map((d) => d.line),
      [7],
    );
    assert.deepEqual(
      at(r.root, "find", "Missing::route")
        .slice(0, 1)
        .map((x) => x.reason),
      ["defines Alpha::route:3 (closest to Missing::route)"],
    );
    const missing = spawnSync(process.execPath, [CLI, "why", "Missing::route"], { cwd: r.root, encoding: "utf8", env: { ...process.env, FINDBRIEF_HOME: r.home } });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /defined in Alpha::route, Beta::route/);
    const fraction = spawnSync(process.execPath, [CLI, "when", "route", "-n", "1.5"], { cwd: r.root, encoding: "utf8", env: { ...process.env, FINDBRIEF_HOME: r.home } });
    assert.equal(fraction.status, 2);
    r.write("crates/sqs/src/raw.rs", "pub fn r#type() {}\n");
    assert.equal(at(r.root, "why", "r#type").definitions[0].file, "crates/sqs/src/raw.rs");
    assert.equal(at(r.root, "find", "r#type")[0].file, "crates/sqs/src/raw.rs");
  } finally {
    r.cleanup();
  }
});

test("an undeclared name is not guessed from a prefix or a typo", () => {
  const r = repo();
  try {
    for (const query of ["QueueA", "parse_queue_anr", "ImaginaryWidgetFactory"]) {
      assert.ok(r.run("find", query, "--json").json.every((x) => !/closest|completes/.test(x.reason)), query);
    }
  } finally {
    r.cleanup();
  }
});

test("untracked files are found after the work tree walk is skipped for unchanged directories", () => {
  const r = repo();
  const age = (dir = r.root) => {
    const old = new Date(Date.now() - 3600 * 1000);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name !== ".git") {
        if (e.isDirectory()) {
          age(path.join(dir, e.name));
        }
        utimesSync(path.join(dir, e.name), old, old);
      }
    }
    utimesSync(dir, old, old);
  };
  const files = (...q) => r.run("find", ...q, "-n", "20", "--json").json.map((x) => x.file);
  try {
    r.write("crates/sqs/src/draft.rs", "pub fn draft_marker_one() {}\n");
    age();
    r.run("index");
    r.run("index");
    assert.ok(files("draft_marker_one").includes("crates/sqs/src/draft.rs"));
    r.write("crates/sqs/src/draft.rs", "pub fn draft_marker_two() {}\n");
    utimesSync(
      path.join(r.root, "crates/sqs/src/draft.rs"),
      new Date(Date.now() - 1800 * 1000),
      new Date(Date.now() - 1800 * 1000),
    );
    age(path.join(r.root, "crates/sqs/src"));
    assert.ok(files("draft_marker_two").includes("crates/sqs/src/draft.rs"));
    r.write("crates/sqs/src/later.rs", "pub fn later_marker() {}\n");
    assert.ok(files("later_marker").includes("crates/sqs/src/later.rs"));
    r.write("notes/deep/idea.rs", "pub fn idea_marker() {}\n");
    assert.ok(files("idea_marker").includes("notes/deep/idea.rs"));
  } finally {
    r.cleanup();
  }
});

test("refs lists the definition, then every mention with its line, within an optional path", () => {
  const r = repo();
  try {
    const all = r.run("refs", "QueueArn", "--json").json;
    assert.deepEqual(all.definitions, [{ name: "QueueArn", kind: "struct", file: "crates/sqs/src/arn.rs", line: 1 }]);
    assert.deepEqual(
      all.files.map((f) => [f.file, f.lines]),
      [
        ["crates/sqs/src/arn.rs", [1, 2]],
        ["crates/sqs/src/service.rs", [1, 2]],
        ["docs/SETUP.md", [4]],
      ],
    );
    assert.deepEqual(r.run("refs", "QueueArn", "docs", "--json").json.files.map((f) => f.file), ["docs/SETUP.md"]);
    assert.equal(r.run("refs", "QueueArn", "-n", "1", "--json").json.moreFiles, 2);
    assert.equal(r.run("refs", "QueueArnX").stdout, "Nothing mentions QueueArnX.\n");
    assert.equal(r.run("refs").status, 2);
  } finally {
    r.cleanup();
  }
});

test("a text match points at the line holding most query terms", () => {
  const results = [
    { file: "a.rs", reason: "matches text" },
    { file: "b.rs", reason: "defines X:1" },
  ];
  assert.deepEqual(
    withTextLines(results, "queue region", () => "one\nthe queue\nqueue region here\n").map((x) => x.reason),
    ["matches text:3", "defines X:1"],
  );
});

test("impact ranks files that change with the target or mention its changed symbols", () => {
  const r = repo();
  try {
    const byPath = r.run("impact", "crates/sqs/src/arn.rs", "--json").json;
    assert.equal(byPath.related[0].file, "crates/sqs/src/service.rs");
    assert.equal(byPath.related[0].cochange.commits, 2);
    assert.deepEqual(byPath.related[0].mentions, ["QueueArn", "parse_queue_arn"]);
    assert.equal(r.run("impact").stdout, "No changes against HEAD.\n");
    r.write(
      "crates/sqs/src/arn.rs",
      "pub struct QueueArn { pub name: String, pub region: String }\npub fn parse_queue_arn(raw: &str) -> QueueArn { unimplemented!() }\n",
    );
    assert.deepEqual(r.run("impact", "--json").json.changed, [{ file: "crates/sqs/src/arn.rs", symbols: ["parse_queue_arn"] }]);
    assert.equal(r.run("impact", "Missing::parse_queue_arn").status, 2);
  } finally {
    r.cleanup();
  }
});

test("the session-start hook prints the brief inside a repository and nothing elsewhere", () => {
  const r = repo();
  try {
    const hook = path.join(path.dirname(CLI), "../hooks/session-start.mjs");
    const run = (input) => spawnSync(process.execPath, [hook], { input, encoding: "utf8", env: { ...process.env, FINDBRIEF_HOME: r.home } });
    const inside = run(JSON.stringify({ cwd: r.root, source: "startup" }));
    assert.equal(inside.status, 0);
    assert.match(inside.stdout, /^findbrief map of this repository[^\n]*\n\n# Context at [0-9a-f]+: /);
    const outside = run(JSON.stringify({ cwd: r.home }));
    assert.deepEqual([outside.status, outside.stdout], [0, ""]);
    assert.equal(run("not json").status, 0);
  } finally {
    r.cleanup();
  }
});

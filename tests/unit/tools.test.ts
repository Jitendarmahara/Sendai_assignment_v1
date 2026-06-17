import { test, expect } from "vitest";
import { shellRun, fsRead } from "../../src/tools/index.ts";

test("shellRun rejects a command not in the allowlist", async () => {
  await expect(shellRun("req", "sess", "tool", "rm -rf /")).rejects.toThrow("COMMAND_NOT_ALLOWED");
});

test("shellRun rejects node with anything other than --version", async () => {
  await expect(shellRun("req", "sess", "tool", "node script.js")).rejects.toThrow("COMMAND_NOT_ALLOWED");
});

test("shellRun rejects an absolute path argument to cat", async () => {
  await expect(shellRun("req", "sess", "tool", "cat /etc/passwd")).rejects.toThrow("PATH_NOT_ALLOWED");
});

test("shellRun rejects path traversal argument to ls", async () => {
  await expect(shellRun("req", "sess", "tool", "ls ../../etc")).rejects.toThrow("PATH_NOT_ALLOWED");
});

test("fsRead rejects absolute paths", async () => {
  await expect(fsRead("req", "sess", "tool", "/etc/passwd")).rejects.toThrow("PATH_NOT_ALLOWED");
});

test("fsRead rejects path traversal", async () => {
  await expect(fsRead("req", "sess", "tool", "../../secret.txt")).rejects.toThrow("PATH_NOT_ALLOWED");
});

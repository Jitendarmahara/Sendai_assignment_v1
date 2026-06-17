import { runInSandbox } from "../sandbox/runner.ts";
import { log } from "../log.ts";

const SINGLE_CMDS = new Set(["pwd", "ls", "cat", "whoami"]);

function validatePath(p: string): void {
  if (p.startsWith("/"))
    throw new Error("PATH_NOT_ALLOWED: absolute paths are not permitted");
  if (p.split("/").includes(".."))
    throw new Error("PATH_NOT_ALLOWED: path traversal is not permitted");
}

export async function shellRun(
  requestId: string,
  sessionId: string,
  toolCallId: string,
  command: string
): Promise<{ pod: string; output: string }> {
  log("info", "tool.call.requested", { requestId, sessionId, toolCallId, tool: "shell.run", command });

  const parts = command.trim().split(/\s+/);
  const cmd = parts[0] ?? "";

  if (cmd === "node") {
    if (parts.join(" ") !== "node --version")
      throw new Error("COMMAND_NOT_ALLOWED: only 'node --version' is permitted");
  } else if (!SINGLE_CMDS.has(cmd)) {
    throw new Error(`COMMAND_NOT_ALLOWED: '${cmd}' is not in the allowlist`);
  }

  if ((cmd === "cat" || cmd === "ls") && parts.length > 1) {
    validatePath(parts[1]!);
  }

  return runInSandbox(requestId, sessionId, toolCallId, parts);
}

export async function fsRead(
  requestId: string,
  sessionId: string,
  toolCallId: string,
  filePath: string
): Promise<{ pod: string; output: string }> {
  log("info", "tool.call.requested", { requestId, sessionId, toolCallId, tool: "fs.read", path: filePath });

  validatePath(filePath);
  return runInSandbox(requestId, sessionId, toolCallId, ["cat", filePath]);
}

export async function envInspect(
  requestId: string,
  sessionId: string,
  toolCallId: string
): Promise<{ pod: string; namespace: string; workingDir: string; user: string; nodeVersion: string }> {
  log("info", "tool.call.requested", { requestId, sessionId, toolCallId, tool: "env.inspect" });

  const { pod, output } = await runInSandbox(requestId, sessionId, toolCallId, [
    "sh",
    "-c",
    "pwd && whoami && (node --version 2>/dev/null || echo n/a)",
  ]);

  const [workingDir = "", user = "", nodeVersion = "n/a"] = output.split("\n");
  return { pod, namespace: "pi-agent", workingDir, user, nodeVersion };
}

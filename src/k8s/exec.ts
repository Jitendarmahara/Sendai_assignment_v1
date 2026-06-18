
import * as k8s from "@kubernetes/client-node";
import stream from "node:stream";
import { kc } from "./client.ts";

const exec = new k8s.Exec(kc);

export async function execInPod(pod: string, command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const stdoutStream = new stream.Writable({
      write(chunk, _enc, cb) {
        stdout += chunk.toString();
        cb();
      },
    });
    const stderrStream = new stream.Writable({
      write(chunk, _enc, cb) {
        stderr += chunk.toString();
        cb();
      },
    });

    exec
      .exec(
        "pi-agent",
        pod,
        "sandbox",
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          if (settled) return;
          settled = true;
          if (status.status === "Success") {
            resolve(stdout.trim());
          } else {
            reject(new Error(stderr.trim() || status.message || "exec failed"));
          }
        }
      )
      .catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
  });
}

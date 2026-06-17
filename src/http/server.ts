import express from "express"
import { coreApi } from "../k8s/client.ts";
import { execInPod } from "../k8s/exec.ts";
import { getPodsStatus } from "../k8s/pods.ts";
import { RealPiClient } from "../pi/pi.ts";
import { v4 as uuidv4 } from "uuid";
import { log } from "../log.ts";

if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY env var is required");
  process.exit(1);
}

const piClient = new RealPiClient();

const app = express();
app.use(express.json());

app.get("/health" , async (_req , res)=>{
    try{
        const response = await coreApi.listNamespacedPod({
            namespace:"pi-agent",
            labelSelector: "app=sandbox-runner"
        });
        const readypodsonly = response.items.filter((x)=>{
            return x.status?.phase === 'Running'
        })
        res.json({
            ok: true,
            kubernetes: "connected",
            sandboxPodsReady: readypodsonly.length
        })
    }catch(e){
        console.error("K8s error:", e);
        res.status(500).json({
            ok:false,
            kubernetes:"disconnected",
            sandboxPodsReady: 0
        })
    }
})

app.get("/exec-test" , async(_req , res)=>{
    try{
        const result = await execInPod("sandbox-runner-0" , ["id"]);
        res.json({pod:"sandbox-runner-0" , output: result})
    }
    catch(e){
        res.status(500).json({error: String(e)});
    }
})
app.get("/pods", async (_req, res) => {
  try {
    const pods = await getPodsStatus();
    res.json({ pods });
  } catch (e) {
    console.error("pods error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body as { message?: string; sessionId?: string };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const requestId = uuidv4();
  const sid = sessionId ?? uuidv4();

  log("info", "chat.request.started", { requestId, sessionId: sid, message });

  try {
    const result = await piClient.runChat({ requestId, sessionId: sid, message });
    log("info", "chat.request.completed", {
      requestId,
      sessionId: sid,
      toolCallCount: result.toolCalls.length,
    });
    res.json(result);
  } catch (e: any) {
    if (e?.message === "CAPACITY_TIMEOUT") {
      res.status(503).json({
        error: {
          code: "sandbox_capacity_timeout",
          message: "No sandbox pod became available within 15 seconds.",
        },
      });
      return;
    }
    console.error("chat error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.use((_req , res)=>{
    return res.status(404).json({
        error:"not found"
    })
})

app.listen(3000 , ()=>{
    console.log("Serve is running on port 3000")
})
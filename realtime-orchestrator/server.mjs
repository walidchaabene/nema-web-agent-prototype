// realtime-orchestrator/server.mjs
import { WebSocket, WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const {
  OPENAI_API_KEY,
  BACKEND_BASE_URL = "http://localhost:8000",
  REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17",
  PORT = "4000",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in realtime-orchestrator/.env");
  process.exit(1);
}

const WS_PORT = Number(PORT) || 4000;

// --------------------
// Helpers
// --------------------
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text.slice(0, 400) };
  }
}

async function getGraphContext(question) {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/tools/get-graph-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[graph-context] backend error:", res.status, body.slice(0, 300));
      return {
        question,
        facts: [],
        actions: [],
        confidence: 0.0,
        reason: `Backend error ${res.status}`,
      };
    }

    return await res.json();
  } catch (err) {
    console.error("[graph-context] error:", err?.message || err);
    return {
      question,
      facts: [],
      actions: [],
      confidence: 0.0,
      reason: "Graph context call failed",
    };
  }
}

function callRealtimeWithGraph(question, graphContext) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      REALTIME_MODEL
    )}`;

    const rtWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let replyBuffer = "";
    let done = false;

    const finish = (text) => {
      if (done) return;
      done = true;
      try {
        rtWs.close();
      } catch {}
      resolve((text || "").trim());
    };

    rtWs.on("open", () => {
      const instructions =
        "You are Nema, a warm, concise sales assistant.\n" +
        "Use graph_context as your factual grounding. Don’t invent policies.\n" +
        "If graph_context is weak, ask one short clarifying question.\n";

      // Configure session
      rtWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text"],
            instructions,
          },
        })
      );

      // Provide question + graph context
      rtWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  user_question: question,
                  graph_context: graphContext,
                }),
              },
            ],
          },
        })
      );

      // Ask model to respond
      rtWs.send(
        JSON.stringify({
          type: "response.create",
          response: { modalities: ["text"] },
        })
      );
    });

    rtWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = msg.type;

      // Support both event names (OpenAI has changed these across previews)
      if (
        (type === "response.output_text.delta" || type === "response.text.delta") &&
        msg.delta
      ) {
        replyBuffer += msg.delta;
      }

      if (type === "response.completed") {
        finish(replyBuffer);
      }

      // Optional: if server sends explicit errors
      if (type === "error") {
        console.error("[realtime] error event:", msg);
        finish(replyBuffer); // return what we have
      }
    });

    rtWs.on("error", (err) => {
      console.error("[realtime] websocket error:", err?.message || err);
      reject(err);
    });

    rtWs.on("close", () => {
      // If it closed without response.completed, return what we got (or "")
      if (!done) finish(replyBuffer);
    });

    // Hard timeout so it never hangs forever
    setTimeout(() => {
      if (!done) {
        console.warn("[realtime] timeout, returning partial reply");
        finish(replyBuffer);
      }
    }, 15000);
  });
}

// --------------------
// Browser-facing WebSocket server
// --------------------
const wsServer = new WebSocketServer({ port: WS_PORT }, () => {
  console.log(`[realtime-orchestrator] WS listening on ws://localhost:${WS_PORT}`);
});

wsServer.on("connection", (client) => {
  console.log("[realtime-orchestrator] browser client connected");

  client.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      client.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (msg.type !== "user_text") return;

    const question = (msg.text || "").trim();
    if (!question) return;

    // 1) get graph context
    const graphContext = await getGraphContext(question);

    // 2) call OpenAI Realtime
    let reply = "";
    try {
      reply = await callRealtimeWithGraph(question, graphContext);
    } catch (e) {
      console.error("[realtime-orchestrator] Realtime call failed:", e?.message || e);
    }

    if (!reply) {
      reply =
        graphContext.reason ||
        "I’m not sure yet—can you share a bit more about what you need?";
    }

    // 3) send to browser
    try {
      client.send(
        JSON.stringify({
          type: "assistant_text",
          text: reply,
          graphContext,
        })
      );
    } catch (e) {
      console.warn("[realtime-orchestrator] send failed:", e?.message || e);
    }
  });

  client.on("close", () => {
    console.log("[realtime-orchestrator] browser client disconnected");
  });
});

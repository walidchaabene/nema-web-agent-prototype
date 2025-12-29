import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import cors from "cors";
import fetch from "node-fetch";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";

dotenv.config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  BACKEND_BASE_URL = "https://api.sophia-podcast-be.com/graph",
  PUBLIC_BASE_URL,
  DEFAULT_AREA_CODE = "206",

  BACKEND_SERVICE_TOKEN,
  TWILIO_NUMBER_SID,

  // Realtime
  OPENAI_API_KEY,
  REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17",
  OPENAI_VOICE = "alloy",
} = process.env;

const PORT = process.env.PORT || 8080;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn(
    "[startup] TWILIO creds missing — phone features disabled until env vars are set"
  );
}
if (!OPENAI_API_KEY) {
  console.warn(
    "[startup] OPENAI_API_KEY missing — Realtime features disabled until env var is set"
  );
}
if (!PUBLIC_BASE_URL || !PUBLIC_BASE_URL.startsWith("https://")) {
  console.warn(
    "[startup] PUBLIC_BASE_URL missing or not https:// — Realtime media-stream URL may be invalid"
  );
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:5174",
      "http://localhost:5173",
      "https://test.dwquiuli5p7pn.amplifyapp.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

console.log("🔥 HARD RESET BUILD 2025-12-29-EB-CACHE-FIX 🔥");

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const server = http.createServer(app);

// ------------ helpers ------------

const now = () => new Date().toISOString();

const safeJsonParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

function backendHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Service-Token": BACKEND_SERVICE_TOKEN,
  };
}

// Nema chat backend (still there if you want to use it elsewhere or as fallback)
async function callNemaAgent(sessionId, message) {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/nema/chat`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({ sessionId, message }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[nema-agent] backend error:", res.status, text);
      return {
        reply: "Sorry, I'm having trouble answering right now.",
        action: "NONE",
      };
    }
    const data = await res.json();
    return data; // { reply, action }
  } catch (err) {
    console.error("[nema-agent] error:", err);
    return {
      reply: "Sorry, something went wrong talking to Nema.",
      action: "NONE",
    };
  }
}

async function postSessionMessage(sessionId, role, text) {
  try {
    await fetch(
      `${BACKEND_BASE_URL}/api/sessions/${encodeURIComponent(
        sessionId
      )}/message`,
      {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify({ role, text }),
      }
    );
  } catch (err) {
    console.error("[session] postSessionMessage error:", err);
  }
}

async function buildGraph(sessionId) {
  try {
    await fetch(
      `${BACKEND_BASE_URL}/api/sessions/${encodeURIComponent(
        sessionId
      )}/build-graph`,
      {
        method: "POST",
        headers: backendHeaders(),
      }
    );
  } catch (err) {
    console.error("[session] build-graph error:", err);
  }
}

async function getBusinessName() {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/business/profile`, {
      headers: backendHeaders(),
    });
    const data = await res.json().catch(() => null);
    const name = data?.profile?.business_name;
    return (name && String(name).trim()) || "our business";
  } catch (err) {
    console.error("[business-name] error:", err);
    return "our business";
  }
}

async function getGraphContext(question) {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/tools/get-graph-context`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[graph-context] backend error:", res.status, text);
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
    console.error("[graph-context] error:", err);
    return {
      question,
      facts: [],
      actions: [],
      confidence: 0.0,
      reason: "Graph context call failed",
    };
  }
}

// ------------ Twilio Media Streams + Realtime ------------

// WebSocket server for Twilio media streams
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

// optional: Twilio stream status callback
app.post("/stream-status", (req, res) => {
  console.log("[stream-status]", now(), req.body);
  res.sendStatus(200);
});

// ------------ Go Live (unchanged, except for RealAPI) ------------

// We reuse a fixed Twilio number by updating its webhook URL with agentId + username.
app.post("/api/phone/go-live", async (req, res) => {
  const { agentId, username } = req.body;

  if (!agentId || !username) {
    return res.status(400).json({
      ok: false,
      error: "agentId and username are required",
    });
  }

  // Twilio will hit /voice?agentId=...&username=...
  const voiceUrl =
    `${PUBLIC_BASE_URL}/voice` +
    `?agentId=${encodeURIComponent(agentId)}` +
    `&username=${encodeURIComponent(username)}`;

  try {
    const incoming = await twilioClient
      .incomingPhoneNumbers(TWILIO_NUMBER_SID)
      .update({
        voiceUrl,
        voiceMethod: "POST",
      });

    return res.json({
      ok: true,
      phoneNumber: incoming.phoneNumber,
      reused: true,
    });
  } catch (err) {
    console.error("[go-live] error updating webhook:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to update webhook",
    });
  }
});

// ------------ /voice: TwiML uses <Connect><Stream> and Realtime ------------

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  let { agentId, username, sessionId } = req.query;

  // Recover agentId/username from sessionId if needed
  if ((!agentId || !username) && sessionId) {
    const parts = String(sessionId).split(":");
    if (parts.length >= 3) {
      username = parts[0];
      agentId = parts[1];
    }
  }

  if (!agentId || !username) {
    twiml.say(
      "This phone agent is not configured yet. Please contact your administrator."
    );
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const callSid = req.body.CallSid || Date.now();
  // encode sessionId as username:agentId:callSid, so backend can resolve graph
  sessionId = sessionId || `${username}:${agentId}:${callSid}`;

  // Build WS URL for Twilio media stream
  const wsBase = PUBLIC_BASE_URL.replace(/^https:\/\//, "wss://");
  const wsUrl = `${wsBase}/media-stream`;

  const connect = twiml.connect();
  const stream = connect.stream({
    url: wsUrl,
    track: "inbound_track",
    statusCallback: `${PUBLIC_BASE_URL}/stream-status`,
    statusCallbackMethod: "POST",
  });

  // pass sessionId into media stream so we can log to backend
  stream.parameter({ name: "sessionId", value: sessionId });

  // Keep call open; Realtime will drive audio
  twiml.pause({ length: 600 });

  res.type("text/xml").send(twiml.toString());
});

// ------------ Realtime orchestration per call ------------

wss.on("connection", (twilioWs, req) => {
  let sessionId = `call-${Date.now()}`;
  let streamSid = null;
  let oaiReady = false;

  const sendToTwilio = (obj) => {
    try {
      twilioWs.send(JSON.stringify(obj));
    } catch (err) {
      console.error("[twilioWs.send] error:", err);
    }
  };

  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const sendToOAI = (obj) => {
    try {
      oaiWs.send(JSON.stringify(obj));
    } catch (err) {
      console.error("[oaiWs.send] error:", err);
    }
  };

  oaiWs.on("open", async () => {
    // Configure Realtime session
    sendToOAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", create_response: false },
        input_audio_transcription: { model: "whisper-1", language: "en" },
        instructions:
          "You are Nema, a warm, concise sales assistant for a flower shop.\n" +
          "Use graph_context facts provided by the system.\n" +
          "Keep responses short (1–2 sentences).\n",
      },
    });

    oaiReady = true;

    // Greet with business name on first connection
    const biz = await getBusinessName();
    const greeting =
      `Hi, this is Nema. Welcome to ${biz}. ` +
      "I can help you explore our products and assist you with orders or questions.";

    sendToOAI({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Say this greeting verbatim:\n${greeting}`,
          },
        ],
      },
    });
    sendToOAI({
      type: "response.create",
      response: { modalities: ["audio", "text"] },
    });
  });

  oaiWs.on("message", async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg?.type) return;

    // Stream audio from Realtime back to Twilio
    if (
      (msg.type === "response.audio.delta" ||
        msg.type === "response.output_audio.delta") &&
      msg.delta
    ) {
      if (streamSid)
        sendToTwilio({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        });
      return;
    }

    // When Whisper finishes transcribing a user turn
    if (
      msg.type ===
      "conversation.item.input_audio_transcription.completed"
    ) {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;

      // Log user turn to Sophia backend for graph building
      postSessionMessage(sessionId, "customer", transcript).catch(() => {});

      const ctx = await getGraphContext(transcript);

      // Feed question + graph context into Realtime as text
      sendToOAI({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                user_question: transcript,
                graph_context: ctx,
                max_sentences: 2,
              }),
            },
          ],
        },
      });
      sendToOAI({
        type: "response.create",
        response: { modalities: ["audio", "text"] },
      });

      return;
    }

    // If you ever want to log Nema's textual reply to Sophia as agent turn:
    // you can also parse msg.type === "response.output_text.done" etc here.
  });

  oaiWs.on("error", (err) => {
    console.error("[oaiWs] error:", err);
  });

  oaiWs.on("close", () => {
    console.log("[oaiWs] closed");
  });

  twilioWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg?.event) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (cp.sessionId) sessionId = cp.sessionId;
      console.log("[twilioWs] start:", streamSid, "sessionId:", sessionId);
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload || !oaiReady) return;
      // pipe μ-law frames into Realtime input buffer
      sendToOAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (msg.event === "stop") {
      console.log("[twilioWs] stop:", streamSid);
      try {
        sendToOAI({ type: "input_audio_buffer.commit" });
        sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("[twilioWs] closed:", streamSid);
    try {
      oaiWs.close();
    } catch {}
  });
});

// ------------ Legacy /gather path (kept for compatibility) ------------
// NOTE: Twilio won’t hit this when using Media Streams, but we keep it around.

app.post("/gather", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const sessionId = req.query.sessionId || req.body.sessionId || "default";
  const speechResult = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  if (!sessionId || !String(sessionId).includes(":")) {
    console.error("[/gather] invalid sessionId", sessionId);
    twiml.say(
      { voice: "Polly.Joanna", language: "en-US" },
      "Sorry, something went wrong with this call."
    );
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  console.log("[/gather] session:", sessionId);
  console.log("[/gather] speechResult:", speechResult);
  console.log("[/gather] confidence:", confidence);

  if (!speechResult) {
    twiml.say(
      { voice: "Polly.Joanna", language: "en-US" },
      "I didn't catch that. Let's try again."
    );
    twiml.redirect(`/voice?sessionId=${encodeURIComponent(sessionId)}`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Log user turn
  await postSessionMessage(sessionId, "customer", speechResult);

  // Use Nema chat backend as a fallback brain if you ever use gather
  const agentResp = await Promise.race([
    callNemaAgent(sessionId, speechResult),
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            reply: "Let me check that for you…",
            action: "NONE",
          }),
        8000
      )
    ),
  ]);

  const replyText =
    (agentResp.reply && agentResp.reply.trim()) ||
    "I'm not sure how to answer that yet.";
  const action = agentResp.action || "NONE";

  console.log("[/gather] Nema reply:", replyText, "action:", action);

  await postSessionMessage(sessionId, "agent", replyText);
  await buildGraph(sessionId);

  twiml.say(
    {
      voice: "Polly.Joanna",
      language: "en-US",
    },
    replyText
  );

  const gather = twiml.gather({
    input: "speech",
    action: `/gather?sessionId=${encodeURIComponent(sessionId)}`,
    method: "POST",
    speechTimeout: "auto",
  });
  gather.say(
    {
      voice: "Polly.Joanna",
      language: "en-US",
    },
    "What else would you like to know?"
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------ Health check ------------

app.get("/", (req, res) => {
  res.send("Twilio ↔ Nema phone orchestrator (Realtime) is running.");
});

server.listen(PORT, "0.0.0.0", () => {
  const wsBase = PUBLIC_BASE_URL
    ? PUBLIC_BASE_URL.replace(/^https:\/\//, "wss://")
    : "(unset)";
  console.log(`Twilio-Nema orchestrator listening on port ${PORT}`);
  console.log(`Media Streams WS path: ${wsBase}/media-stream`);
  console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
});

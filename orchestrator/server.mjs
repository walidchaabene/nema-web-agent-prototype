// server.mjs (FULL) — Stable Twilio + Media Streams + Realtime
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import cors from "cors";
import fetch from "node-fetch";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";

dotenv.config();

process.on("uncaughtException", (err) =>
  console.error("[fatal] uncaughtException", err)
);
process.on("unhandledRejection", (err) =>
  console.error("[fatal] unhandledRejection", err)
);

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  BACKEND_BASE_URL = "https://api.sophia-podcast-be.com/graph",
  PUBLIC_BASE_URL,

  BACKEND_SERVICE_TOKEN,
  TWILIO_NUMBER_SID,

  OPENAI_API_KEY,
  REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17",
  OPENAI_VOICE = "alloy",
} = process.env;

const PORT = process.env.PORT || 8080;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("[startup] TWILIO creds missing");
if (!OPENAI_API_KEY) console.warn("[startup] OPENAI_API_KEY missing — Realtime disabled");
if (!PUBLIC_BASE_URL || !PUBLIC_BASE_URL.startsWith("https://"))
  console.warn("[startup] PUBLIC_BASE_URL missing or not https://");
if (!BACKEND_SERVICE_TOKEN)
  console.warn("[startup] BACKEND_SERVICE_TOKEN missing — tool calls will fail");

const safeJsonParse = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

const LOG_SAMPLE_RATE = Number(process.env.LOG_SAMPLE_RATE || "0.1");
const slog = (...args) => {
  if (LOG_SAMPLE_RATE >= 1 || Math.random() < LOG_SAMPLE_RATE) console.log(...args);
};

function backendHeaders(sessionId) {
  return {
    "Content-Type": "application/json",
    "X-Service-Token": BACKEND_SERVICE_TOKEN,
    ...(sessionId ? { "X-Session-Id": sessionId } : {}),
  };
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

async function postSessionMessage(sessionId, role, text) {
  try {
    await fetchWithTimeout(
      `${BACKEND_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        headers: backendHeaders(sessionId),
        body: JSON.stringify({ role, text }),
      },
      5000
    );
  } catch (err) {
    console.error("[session] postSessionMessage error:", err);
  }
}

async function getGraphContext(question, sessionId) {
  const url = `${BACKEND_BASE_URL}/api/tools/get-graph-context`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: backendHeaders(sessionId),
        body: JSON.stringify({ question }),
      },
      6000
    );

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    slog("[graph-context]", { status: res.status, q: (question || "").slice(0, 80) });

    if (!res.ok) {
      console.error("[graph-context] BAD", { status: res.status, body: text.slice(0, 200) });
      return { question, facts: [], actions: [], confidence: 0.0, reason: `Backend error ${res.status}` };
    }

    return data;
  } catch (err) {
    console.error("[graph-context] EXCEPTION", { err: String(err) });
    return { question, facts: [], actions: [], confidence: 0.0, reason: "Graph context call failed" };
  }
}

async function getBusinessProfile(sessionId) {
  const url = `${BACKEND_BASE_URL}/api/business/profile`;
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: backendHeaders(sessionId) },
      3500
    );
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok || !data) {
      slog("[biz-profile] non-200", { status: res.status, body: text.slice(0, 120) });
      return { business_name: "our business", overview: "We create and deliver fresh flower arrangements." };
    }
    return data;
  } catch (err) {
    slog("[biz-profile] exception", String(err));
    return { business_name: "our business", overview: "We create and deliver fresh flower arrangements." };
  }
}

// ---------- app ----------
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.disable("x-powered-by");

app.use(
  cors({
    origin: [
      "http://localhost:5174",
      "http://localhost:5173",
      "https://test.dwquiuli5p7pn.amplifyapp.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Service-Token", "X-Session-Id"],
  })
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

app.get("/health", (req, res) => res.status(200).send("ok"));
app.post("/stream-status", (req, res) => res.sendStatus(204));

app.post("/api/phone/go-live", async (req, res) => {
  const { agentId, username } = req.body || {};
  if (!agentId || !username) {
    return res.status(400).json({ ok: false, error: "agentId and username are required" });
  }

  const voiceUrl =
    `${PUBLIC_BASE_URL}/voice` +
    `?agentId=${encodeURIComponent(agentId)}` +
    `&username=${encodeURIComponent(username)}`;

  try {
    const incoming = await twilioClient
      .incomingPhoneNumbers(TWILIO_NUMBER_SID)
      .update({ voiceUrl, voiceMethod: "POST" });

    return res.json({ ok: true, phoneNumber: incoming.phoneNumber, reused: true });
  } catch (err) {
    console.error("[go-live] error updating webhook:", err);
    return res.status(500).json({ ok: false, error: "Failed to update webhook" });
  }
});

app.post("/voice", (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const agentId = req.query.agentId;
    const username = req.query.username;

    if (!agentId || !username) {
      twiml.say("This phone agent is not configured yet.");
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    const callSid = req.body?.CallSid || Date.now();
    const sessionId = `${username}:${agentId}:${callSid}`;

    const wsUrl = PUBLIC_BASE_URL.replace(/^https:\/\//, "wss://") + "/media-stream";

    const connect = twiml.connect();
    const stream = connect.stream({
      url: wsUrl,
      track: "inbound_track",
      statusCallback: `${PUBLIC_BASE_URL}/stream-status`,
      statusCallbackMethod: "POST",
    });

    stream.parameter({ name: "sessionId", value: sessionId });
    twiml.pause({ length: 600 });

    return res.type("text/xml").status(200).send(twiml.toString());
  } catch {
    return res.sendStatus(204);
  }
});

// ---------- Media Streams WS ----------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

const PRIME_ULAW_SILENCE_B64 = "////////////////////////////////////////////////////////////////";

wss.on("connection", (twilioWs) => {
  let sessionId = `call-${Date.now()}`;
  let streamSid = null;

  let twilioMediaFrames = 0;
  let oaiAudioFrames = 0;

  const pendingAudio = [];
  const MAX_PENDING_AUDIO = 300;

  let oaiReady = false;

  const sendToTwilio = (obj) => {
    try { twilioWs.send(JSON.stringify(obj)); }
    catch (err) { console.error("[twilioWs.send] error:", err); }
  };

  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const sendToOAI = (obj) => {
    try { if (oaiWs.readyState === 1) oaiWs.send(JSON.stringify(obj)); }
    catch (err) { console.error("[oaiWs.send] error:", err); }
  };

  const flushPendingAudio = () => {
    if (!streamSid) return;
    while (pendingAudio.length) {
      const delta = pendingAudio.shift();
      sendToTwilio({ event: "media", streamSid, media: { payload: delta } });
    }
  };

  const callSummary = (label) => {
    slog("[call-summary]", { label, sessionId, streamSid, twilioMediaFrames, oaiAudioFrames });
  };

  oaiWs.on("open", async () => {
    slog("[oaiWs] open", { sessionId });

    sendToOAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", create_response: true },
        input_audio_transcription: { model: "whisper-1", language: "en" },
        instructions:
          "You are Nema, a warm, concise sales assistant.\n" +
          "You will receive JSON with {user_question, graph_context}.\n" +
          "If graph_context.facts is non-empty, answer using ONLY those facts.\n" +
          "If empty, ask ONE clarifying question.\n" +
          "Keep responses 1–2 sentences.\n",
      },
    });

    oaiReady = true;

    // ✅ Fetch business profile (name + overview) for greeting
    const profile = await getBusinessProfile(sessionId);
    const bizName = profile?.business_name || "our business";
    const overview = profile?.overview || "We create and deliver fresh flower arrangements.";

    const greeting =
      `Hi, this is Neema from ${bizName}. ` +
      `${overview} How can I help you today?`;

    sendToOAI({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Say this greeting verbatim:\n${greeting}` }],
      },
    });

    sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });

    setTimeout(() => {
      if (oaiAudioFrames === 0 && oaiWs.readyState === 1) {
        console.warn("[failsafe] no audio yet, forcing response.create()");
        sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });
      }
    }, 1500);
  });

  oaiWs.on("message", async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg?.type) return;

    if (
      (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") &&
      msg.delta
    ) {
      oaiAudioFrames++;
      if (!streamSid) {
        pendingAudio.push(msg.delta);
        if (pendingAudio.length > MAX_PENDING_AUDIO) pendingAudio.shift();
        return;
      }
      sendToTwilio({ event: "media", streamSid, media: { payload: msg.delta } });
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;

      slog("[whisper]", transcript.slice(0, 120));

      postSessionMessage(sessionId, "customer", transcript).catch(() => {});
      const ctx = await getGraphContext(transcript, sessionId);

      slog("[ctx]", { factsLen: Array.isArray(ctx?.facts) ? ctx.facts.length : 0, reason: ctx?.reason });

      sendToOAI({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify({ user_question: transcript, graph_context: ctx, max_sentences: 2 }) }],
        },
      });

      sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });
    }
  });

  oaiWs.on("error", (err) => console.error("[oaiWs] error:", err));
  oaiWs.on("close", () => slog("[oaiWs] closed"));

  twilioWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg?.event) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (cp.sessionId) sessionId = cp.sessionId;

      slog("[twilioWs] start", { streamSid, sessionId });

      if (streamSid) {
        sendToTwilio({ event: "media", streamSid, media: { payload: PRIME_ULAW_SILENCE_B64 } });
      }
      flushPendingAudio();
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload || !oaiReady) return;
      twilioMediaFrames++;
      sendToOAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (msg.event === "stop") {
      slog("[twilioWs] stop", streamSid);
      callSummary("stop");
      try {
        sendToOAI({ type: "input_audio_buffer.commit" });
        sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    callSummary("close");
    try { oaiWs.close(); } catch {}
  });
});

app.get("/", (req, res) =>
  res.send("Twilio ↔ Nema phone orchestrator (Realtime) is running.")
);

server.listen(PORT, "0.0.0.0", () => {
  const wsBase = PUBLIC_BASE_URL ? PUBLIC_BASE_URL.replace(/^https:\/\//, "wss://") : "(unset)";
  console.log(`Twilio-Nema orchestrator listening on port ${PORT}`);
  console.log(`Health: ${PUBLIC_BASE_URL}/health`);
  console.log(`Media Streams WS path: ${wsBase}/media-stream`);
  console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`BACKEND_BASE_URL: ${BACKEND_BASE_URL}`);
});

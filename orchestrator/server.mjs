// server.mjs (FULL) — Stable Twilio + Media Streams + Realtime
//
// Includes ALL fixes we agreed on:
// ✅ /voice: ultra-fast, no logging, no awaits, Twilio-safe (never 5xx)
// ✅ /stream-status: 204 immediately (no logging)
// ✅ /health: fast
// ✅ Reduced log pressure everywhere else via sampled logger
// ✅ Media stream: audio buffering until streamSid exists
// ✅ Media stream: PRIMING AUDIO FRAME immediately on Twilio "start" (prevents silent calls)
// ✅ Realtime: turn_detection create_response: true (more reliable)
// ✅ Realtime: greeting + failsafe response.create if no audio deltas within 1.5s
// ✅ Counters + call summary: twilioMediaFrames + oaiAudioFrames (debug silent calls quickly)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import cors from "cors";
import fetch from "node-fetch";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";

dotenv.config();

// Crash visibility
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

  // Realtime
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

// ---------- small helpers ----------
const safeJsonParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// sampled logger to avoid stdout backpressure stalls
const LOG_SAMPLE_RATE = Number(process.env.LOG_SAMPLE_RATE || "0.1"); // 10% default
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
    try {
      data = JSON.parse(text);
    } catch {}

    // keep logs light
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

app.use(bodyParser.urlencoded({ extended: false })); // Twilio /voice
app.use(bodyParser.json()); // internal

const server = http.createServer(app);

// keepalive tuning (harmless, sometimes helps)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

// ---------- Health ----------
app.get("/health", (req, res) => res.status(200).send("ok"));

// ---------- Stream status callback (Twilio wants FAST 2xx) ----------
app.post("/stream-status", (req, res) => res.sendStatus(204));

// ---------- Go Live ----------
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

// ---------- /voice (ultra-fast, no logs, no awaits) ----------
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
      track: "inbound_track", // keep as-is; change to both_tracks only if you suspect no inbound media
      statusCallback: `${PUBLIC_BASE_URL}/stream-status`,
      statusCallbackMethod: "POST",
    });

    stream.parameter({ name: "sessionId", value: sessionId });

    twiml.pause({ length: 600 });

    return res.type("text/xml").status(200).send(twiml.toString());
  } catch {
    // Twilio-safe fallback: never 5xx
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

// A small base64 μ-law "silence" chunk to prime Twilio playback.
// (Any short payload works; this is a common safe pattern.)
const PRIME_ULAW_SILENCE_B64 = "////////////////////////////////////////////////////////////////";

wss.on("connection", (twilioWs) => {
  let sessionId = `call-${Date.now()}`;
  let streamSid = null;

  // Counters to debug silence
  let twilioMediaFrames = 0;
  let oaiAudioFrames = 0;

  // Buffer audio until streamSid exists
  const pendingAudio = [];
  const MAX_PENDING_AUDIO = 300;

  let oaiReady = false;

  const sendToTwilio = (obj) => {
    try {
      twilioWs.send(JSON.stringify(obj));
    } catch (err) {
      console.error("[twilioWs.send] error:", err);
    }
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
    try {
      if (oaiWs.readyState === 1) oaiWs.send(JSON.stringify(obj));
    } catch (err) {
      console.error("[oaiWs.send] error:", err);
    }
  };

  const flushPendingAudio = () => {
    if (!streamSid) return;
    while (pendingAudio.length) {
      const delta = pendingAudio.shift();
      sendToTwilio({ event: "media", streamSid, media: { payload: delta } });
    }
  };

  const callSummary = (label) => {
    slog("[call-summary]", {
      label,
      sessionId,
      streamSid,
      twilioMediaFrames,
      oaiAudioFrames,
    });
  };

  // ---- OpenAI Realtime wiring ----
  oaiWs.on("open", () => {
    slog("[oaiWs] open", { sessionId });

    // Make responses more automatic/reliable
    sendToOAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", create_response: true }, // FIX
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

    // Greeting
    const greeting =
      "Hi, this is Nema. Welcome. I can help you with questions or place an order.";

    sendToOAI({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Say this greeting verbatim:\n${greeting}` }],
      },
    });

    // explicit create (still fine even with create_response: true)
    sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });

    // FAILSAFE: if no audio after 1.5s, force another response.create
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

    // OpenAI -> Twilio audio
    if (
      (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") &&
      msg.delta
    ) {
      oaiAudioFrames++;
      if (oaiAudioFrames % 50 === 0) slog("[oai] audio frames", oaiAudioFrames);

      if (!streamSid) {
        pendingAudio.push(msg.delta);
        if (pendingAudio.length > MAX_PENDING_AUDIO) pendingAudio.shift();
        return;
      }

      sendToTwilio({ event: "media", streamSid, media: { payload: msg.delta } });
      return;
    }

    // Whisper transcription done
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;

      slog("[whisper]", transcript.slice(0, 120));

      postSessionMessage(sessionId, "customer", transcript).catch(() => {});
      const ctx = await getGraphContext(transcript, sessionId);

      slog("[ctx]", {
        factsLen: Array.isArray(ctx?.facts) ? ctx.facts.length : 0,
        reason: ctx?.reason,
      });

      sendToOAI({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({ user_question: transcript, graph_context: ctx, max_sentences: 2 }),
            },
          ],
        },
      });

      sendToOAI({ type: "response.create", response: { modalities: ["audio", "text"] } });
      return;
    }
  });

  oaiWs.on("error", (err) => console.error("[oaiWs] error:", err));
  oaiWs.on("close", () => {
    slog("[oaiWs] closed");
  });

  // ---- Twilio WS wiring ----
  twilioWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg?.event) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (cp.sessionId) sessionId = cp.sessionId;

      slog("[twilioWs] start", { streamSid, sessionId });

      // PRIME: send a tiny silence chunk immediately so Twilio pipeline is "hot"
      if (streamSid) {
        sendToTwilio({
          event: "media",
          streamSid,
          media: { payload: PRIME_ULAW_SILENCE_B64 },
        });
      }

      // flush any OpenAI audio that arrived before start
      flushPendingAudio();
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload || !oaiReady) return;

      twilioMediaFrames++;
      if (twilioMediaFrames % 50 === 0) slog("[twilio] media frames", twilioMediaFrames);

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
    try {
      oaiWs.close();
    } catch {}
  });
});

// ---------- Basic home page ----------
app.get("/", (req, res) => res.send("Twilio ↔ Nema phone orchestrator (Realtime) is running."));

server.listen(PORT, "0.0.0.0", () => {
  const wsBase = PUBLIC_BASE_URL ? PUBLIC_BASE_URL.replace(/^https:\/\//, "wss://") : "(unset)";
  console.log(`Twilio-Nema orchestrator listening on port ${PORT}`);
  console.log(`Health: ${PUBLIC_BASE_URL}/health`);
  console.log(`Media Streams WS path: ${wsBase}/media-stream`);
  console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`BACKEND_BASE_URL: ${BACKEND_BASE_URL}`);
});

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import fetch from "node-fetch";
import cors from "cors";


dotenv.config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  BACKEND_BASE_URL = "http://localhost:8000",
  PUBLIC_BASE_URL,
  DEFAULT_AREA_CODE = "206",
  PORT = process.env.PORT || 3003,
} = process.env;



if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn(
    "[startup] TWILIO creds missing — phone features disabled until env vars are set"
  );
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();

app.use(cors({ origin: true }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio sends URL-encoded form bodies
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ------------------------------------------------------------
// Call your Nema chat backend (same brain as chat UX)
// ------------------------------------------------------------

async function callNemaAgent(sessionId, message) {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/nema/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    // Expecting { reply: string, action?: string }
    return data;
  } catch (err) {
    console.error("[nema-agent] error:", err);
    return {
      reply: "Sorry, something went wrong talking to Nema.",
      action: "NONE",
    };
  }
}

// ------------------------------------------------------------
// Session logging helpers so phone calls feed the graph
// ------------------------------------------------------------

async function postSessionMessage(sessionId, role, text) {
  try {
    await fetch(
      `${BACKEND_BASE_URL}/api/sessions/${encodeURIComponent(
        sessionId
      )}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      { method: "POST" }
    );
  } catch (err) {
    console.error("[session] build-graph error:", err);
  }
}

// ------------------------------------------------------------
// Go Live API: /api/phone/go-live
//  - Finds an available Twilio number
//  - Purchases it
//  - Sets its Voice webhook to PUBLIC_BASE_URL/voice
//  - Returns the number to the frontend
// ------------------------------------------------------------

app.post("/api/phone/go-live", async (req, res) => {
  if (!PUBLIC_BASE_URL) {
    return res.status(400).json({
      ok: false,
      error:
        "PUBLIC_BASE_URL is not set in orchestrator .env. Set it to your public webhook base URL (e.g. ngrok URL).",
    });
  }

  const areaCode =
    (req.body && req.body.areaCode) || DEFAULT_AREA_CODE || "206";

  try {
    // 1) Find an available local number with voice enabled
    const available = await twilioClient
      .availablePhoneNumbers("US")
      .local.list({ areaCode, voiceEnabled: true, limit: 1 });

    if (!available.length) {
      return res.status(400).json({
        ok: false,
        error: `No available numbers found for area code ${areaCode}`,
      });
    }

    const candidate = available[0];
    console.log("[go-live] Found available number:", candidate.phoneNumber);

    // 2) Purchase and configure the number
    const voiceUrl = `${PUBLIC_BASE_URL}/voice`;
    const incoming = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: candidate.phoneNumber,
      friendlyName: "Nema Phone Agent",
      voiceUrl,
      voiceMethod: "POST",
    });

    console.log("[go-live] Purchased number:", incoming.phoneNumber);
    console.log("[go-live] Voice URL:", voiceUrl);

    return res.json({
      ok: true,
      phoneNumber: incoming.phoneNumber,
      voiceUrl,
    });
  } catch (err) {
    console.error("[go-live] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to purchase/configure phone number. Check Twilio logs.",
    });
  }
});

// ------------------------------------------------------------
// Voice entry point: /voice
// ------------------------------------------------------------

app.post("/voice", (req, res) => {
  console.log("[/voice] incoming call body:", req.body);

  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || `call-${Date.now()}`;
  const sessionId = callSid;

  const greeting =
    "Hi, this is Nema, your sales assistant. How can I help you today?";

  // Log initial greeting as agent turn (optional)
  postSessionMessage(sessionId, "agent", greeting).catch(() => {});

  twiml.say(
    {
      voice: "Polly.Joanna",
      language: "en-US",
    },
    greeting
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
    "You can ask about delivery, availability, or pricing."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// /gather: Twilio STT → Nema → Twilio TTS
// ------------------------------------------------------------

app.post("/gather", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const sessionId = req.query.sessionId || req.body.sessionId || "default";
  const speechResult = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  console.log("[/gather] session:", sessionId);
  console.log("[/gather] speechResult:", speechResult);
  console.log("[/gather] confidence:", confidence);

  if (!speechResult) {
    twiml.say(
      { voice: "Polly.Joanna", language: "en-US" },
      "I didn't catch that. Let's try again."
    );
    twiml.redirect("/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Log user turn
  await postSessionMessage(sessionId, "customer", speechResult);

  // Call Nema chat backend (graph-informed brain)
  const agentResp = await callNemaAgent(sessionId, speechResult);
  const replyText =
    (agentResp.reply && agentResp.reply.trim()) ||
    "I'm not sure how to answer that yet.";
  const action = agentResp.action || "NONE";

  console.log("[/gather] Nema reply:", replyText, "action:", action);

  // Log agent turn
  await postSessionMessage(sessionId, "agent", replyText);

  // Integrate this session into the graph (Build / Update Graph)
  await buildGraph(sessionId);

  // Speak Nema's reply via Twilio
  twiml.say(
    {
      voice: "Polly.Joanna",
      language: "en-US",
    },
    replyText
  );

  // Loop: ask user for another question
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

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.send("Twilio ↔ Nema phone orchestrator is running.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Twilio-Nema orchestrator listening on port ${PORT}`);
});

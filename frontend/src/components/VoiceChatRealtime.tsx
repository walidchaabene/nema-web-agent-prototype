import React, { useEffect, useRef, useState } from "react";

type Role = "customer" | "agent";

interface ChatTurn {
  role: Role;
  text: string;
}

interface Props {
  sessionId: string;
  onBuildGraph: () => void;
}

const API_BASE = "http://localhost:8000";

export const VoiceChatRealtime: React.FC<Props> = ({
  sessionId,
  onBuildGraph,
}) => {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const appendTurn = (role: Role, text: string) => {
    if (!text.trim()) return;
    setHistory((h) => [...h, { role, text }]);
  };

  const postSessionMessage = async (role: Role, text: string) => {
    try {
      await fetch(
        `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, text }),
        }
      );
    } catch (e) {
      console.error("Failed to post session message", e);
    }
  };

  // ----- Browser TTS -----

  const speakText = (text: string) => {
    if (!("speechSynthesis" in window)) {
      console.warn("SpeechSynthesis not supported in this browser");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  // ----- Graph QA -----

  const askGraph = async (userText: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/graph/qa-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: userText }),
      });
      const data = await res.json();
      const answer: string | null = data.answer ?? null;
      const reason: string | null = data.reason ?? null;

      const finalAnswer =
        answer && answer.trim()
          ? answer
          : reason ||
            "I’m not sure about that yet. I don’t have this answer in my memory.";

      appendTurn("agent", finalAnswer);
      await postSessionMessage("agent", finalAnswer);
      speakText(finalAnswer);
    } catch (err: any) {
      console.error("qa-answer error", err);
      const fallback =
        "Sorry, I couldn’t reach my memory service. Please try again.";
      appendTurn("agent", fallback);
      await postSessionMessage("agent", fallback);
      speakText(fallback);
    }
  };

  // ----- Handle Realtime events (STT only) -----

  const handleServerEvent = async (msg: any) => {
    const type = msg?.type;
    if (!type) return;

    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript: string = msg.transcript || "";
      if (!transcript.trim()) return;

      appendTurn("customer", transcript);
      await postSessionMessage("customer", transcript);

      await askGraph(transcript);
    }
  };

  // ----- Realtime connection -----

  const cleanup = () => {
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;
    dcRef.current = null;

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }

    setIsConnected(false);
  };

  const startSession = async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    setError(null);

    try {
      const realtimeResp = await fetch(`${API_BASE}/api/realtime/session`, {
        method: "POST",
      });
      const json = await realtimeResp.json();
      if (!json.ok) {
        throw new Error(json.error || "Failed to create Realtime session");
      }
      const session = json.session;
      const ephemeralKey: string = session.client_secret.value;
      const model: string =
        session.model || "gpt-4o-realtime-preview-2024-12-17";

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // We don't rely on Realtime audio output anymore
      pc.ontrack = (e) => {
        console.log("Received Realtime audio track (unused)");
      };

      const ms = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioStreamRef.current = ms;
      const track = ms.getAudioTracks()[0];
      pc.addTrack(track, ms);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        console.log("Data channel open");

        const sessionUpdate = {
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            voice: "alloy",
            instructions:
              "You only transcribe the user's speech. Another service supplies your replies.",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: {
              model: "whisper-1",
              language: "en",
            },
            turn_detection: {
              type: "server_vad",
              create_response: false,
            },
          },
        };

        dc.send(JSON.stringify(sessionUpdate));
      });

      dc.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerEvent(msg);
        } catch (e) {
          console.warn("Failed to parse Realtime event", e);
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const sdpResponse = await fetch(
        `${baseUrl}?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            "Content-Type": "application/sdp",
          },
        }
      );

      if (!sdpResponse.ok) {
        const text = await sdpResponse.text();
        throw new Error(
          `Realtime SDP error: ${sdpResponse.status} ${text.slice(0, 200)}`
        );
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setIsConnected(true);
      setIsConnecting(false);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Realtime connection failed");
      setIsConnecting(false);
      cleanup();
    }
  };

  const stopSession = () => {
    cleanup();
  };

  const buildGraph = async () => {
    await fetch(
      `${API_BASE}/api/sessions/${encodeURIComponent(
        sessionId
      )}/build-graph`,
      {
        method: "POST",
      }
    );
    onBuildGraph();
  };

  useEffect(() => {
    return () => cleanup();
  }, []);

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">Customer ↔ Nema (Voice)</div>
        <button className="button button-primary" onClick={buildGraph}>
          Build / Update Graph
        </button>
      </div>

      <div className="chat-history">
        {history.map((m, idx) => (
          <div
            key={idx}
            className={
              "chat-message " +
              (m.role === "customer"
                ? "chat-message-user"
                : "chat-message-agent")
            }
          >
            <span className="chat-message-label">
              {m.role === "customer" ? "Customer" : "Nema (Agent)"}
            </span>
            <span>{m.text}</span>
          </div>
        ))}
      </div>

      {error && (
        <div
          style={{
            fontSize: 11,
            color: "#f97316",
            marginBottom: 6,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}

      <div className="chat-input-row">
        <button
          className="chat-send-button"
          onClick={startSession}
          disabled={isConnecting || isConnected}
        >
          {isConnected ? "Connected (speak!)" : "Start Voice Session"}
        </button>
        {isConnected && (
          <button
            className="button"
            style={{ fontSize: 11, padding: "4px 10px" }}
            onClick={stopSession}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
};

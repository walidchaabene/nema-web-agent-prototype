import React, { useEffect, useRef, useState } from "react";

const API_BASE = "http://localhost:8000";

interface Props {
  sessionId: string;
  onGraphUpdated: () => void;
}

type Role = "customer" | "agent";

interface ChatTurn {
  role: Role;
  text: string;
}

export const GraphChatPanel: React.FC<Props> = ({
  sessionId,
  onGraphUpdated,
}) => {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

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
      console.error("postSessionMessage error", e);
    }
  };

  const playAudioBase64 = (b64: string | null | undefined) => {
    if (!b64) return;
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play();
    } catch (e) {
      console.warn("Audio playback error", e);
    }
  };

  const sendAudioForQA = async (blob: Blob) => {
    setBusy(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", blob, "user-input.webm");

      const res = await fetch(`${API_BASE}/api/voice/qa-tts`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      const transcript: string = data.transcript || "";
      const answer: string | null = data.answer ?? null;
      const reason: string | null = data.reason ?? null;

      if (transcript) {
        appendTurn("customer", transcript);
        await postSessionMessage("customer", transcript);
      }

      const reply =
        answer && answer.trim()
          ? answer
          : reason || "I don’t have that in my memory yet.";

      appendTurn("agent", reply);
      await postSessionMessage("agent", reply);

      playAudioBase64(data.audio_base64);
      onGraphUpdated();
    } catch (e: any) {
      console.error("voice qa-tts error", e);
      const msg =
        "Error calling voice QA/TTS service. Check backend logs and keys.";
      setError(msg);
      appendTurn("agent", msg);
      await postSessionMessage("agent", msg);
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    if (isRecording || busy) return;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const rec = new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];
        stream.getTracks().forEach((t) => t.stop());
        sendAudioForQA(blob);
      };

      rec.start();
      setIsRecording(true);
    } catch (e: any) {
      console.error("getUserMedia error", e);
      setError(
        "Could not access microphone. Check browser permissions and try again."
      );
    }
  };

  const stopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (!rec || rec.state !== "recording") return;
    rec.stop();
    setIsRecording(false);
  };

  const buildGraph = async () => {
    try {
      await fetch(
        `${API_BASE}/api/sessions/${encodeURIComponent(
          sessionId
        )}/build-graph`,
        { method: "POST" }
      );
      onGraphUpdated();
    } catch (e) {
      console.error("build-graph error", e);
    }
  };

  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop();
      } catch {}
    };
  }, []);

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">Customer ↔ Nema (Voice)</div>
        <button
          className="button"
          style={{ fontSize: 11, padding: "4px 10px" }}
          onClick={buildGraph}
          disabled={busy}
        >
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

      <div className="chat-input-row" style={{ justifyContent: "center" }}>
        <button
          className="chat-send-button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={busy}
        >
          {busy
            ? "Processing…"
            : isRecording
            ? "Stop & Send"
            : "Hold to Speak"}
        </button>
      </div>
    </div>
  );
};

// frontend/src/components/GraphVoiceChat.tsx
import React, { useState } from "react";

type Role = "customer" | "agent";

interface ChatTurn {
  role: Role;
  text: string;
  actions?: string[];
}

const API_BASE = "http://localhost:8000";

export const GraphVoiceChat: React.FC = () => {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [ingestStatus, setIngestStatus] = useState<string | null>(null);
  const [loadingIngest, setLoadingIngest] = useState(false);
  const [loadingQA, setLoadingQA] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appendTurn = (role: Role, text: string, actions?: string[]) => {
    if (!text.trim() && (!actions || actions.length === 0)) return;
    setHistory((h) => [...h, { role, text, actions }]);
  };

  const playAudioBase64 = (audioBase64: string) => {
    const audioBuffer = Uint8Array.from(atob(audioBase64), (c) =>
      c.charCodeAt(0)
    );
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
  };

  const ingestSite = async () => {
    const url = websiteUrl.trim();
    if (!url || loadingIngest) return;
    setLoadingIngest(true);
    setIngestStatus("Crawling and building graph…");
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/website/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!data.ok) {
        setIngestStatus(null);
        setError(data.error || "Website ingest failed. Check backend logs.");
      } else {
        const summary = data.summary || {};
        setIngestStatus(
          `Ingested. Clues: ${summary.clue_count}, Q/A: ${summary.qa_count}.`
        );
      }
    } catch (e: any) {
      setIngestStatus(null);
      setError(e.message || "Ingest request failed");
    } finally {
      setLoadingIngest(false);
    }
  };

  const send = async () => {
    const question = input.trim();
    if (!question || loadingQA) return;
    setLoadingQA(true);
    setError(null);

    appendTurn("customer", question);
    setInput("");

    try {
      const res = await fetch(`${API_BASE}/api/graph/qa-tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();

      if (data.reason) {
        appendTurn("agent", data.reason);
        setError(data.reason);
        setLoadingQA(false);
        return;
      }

      const answer: string = data.answer;
      const actions: string[] =
        (data.actions || []).map((a: any) => a.label || a.id) ?? [];

      appendTurn("agent", answer, actions);

      if (data.audio_base64) {
        playAudioBase64(data.audio_base64);
      }
    } catch (e: any) {
      console.error(e);
      const msg = e.message || "Request failed";
      setError(msg);
      appendTurn("agent", msg);
    } finally {
      setLoadingQA(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="voice-panel">
      {/* Top: website ingest */}
      <div className="section">
        <div className="section-header">Website link</div>
        <div className="section-caption">
          Paste your business URL and click <b>Ingest</b>. Nema will crawl via
          Firecrawl + OpenAI and build a graph of clues, questions, answers,
          and actions (Take order, Book pickup time, Update ledger).
        </div>
        <div className="row">
          <input
            className="input"
            placeholder="https://your-business-site.com"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
          />
          <button
            className="btn primary"
            onClick={ingestSite}
            disabled={loadingIngest}
          >
            {loadingIngest ? "Ingesting…" : "Ingest"}
          </button>
        </div>
        {ingestStatus && (
          <div className="status status-ok">{ingestStatus}</div>
        )}
      </div>

      {/* Middle: chat history */}
      <div className="history">
        {history.map((m, idx) => (
          <div
            key={idx}
            className={
              "bubble " +
              (m.role === "customer" ? "bubble-user" : "bubble-agent")
            }
          >
            <div className="bubble-label">
              {m.role === "customer" ? "Customer" : "Nema"}
            </div>
            <div>{m.text}</div>
            {m.role === "agent" && m.actions && m.actions.length > 0 && (
              <div className="actions">
                Actions:
                {m.actions.map((a) => (
                  <span key={a} className="chip">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <div className="status status-error">{error}</div>}

      {/* Bottom: input */}
      <div className="row">
        <input
          className="input"
          placeholder="Ask Nema a question – she will answer only from the graph"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
        />
        <button
          className="btn primary"
          onClick={send}
          disabled={loadingQA}
        >
          {loadingQA ? "Thinking…" : "Ask & play"}
        </button>
      </div>
    </div>
  );
};

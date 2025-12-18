import React, { useState } from "react";

type Role = "user" | "agent";

interface ChatTurn {
  role: Role;
  text: string;
}

interface Props {
  sessionId: string;
  onBuildGraph: () => void;
}

const API_BASE = "http://localhost:8000";

export const ChatSimulator: React.FC<Props> = ({ sessionId, onBuildGraph }) => {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [isSending, setIsSending] = useState(false);

  const sendMessage = async () => {
    if (!text.trim() || isSending) return;
    const userText = text.trim();
    setText("");
    setIsSending(true);

    // show user bubble immediately
    setHistory((h) => [...h, { role: "user", text: userText }]);

    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: userText }),
      });
      const data = await res.json();
      const reply = data.reply ?? "";

      // show Nema's reply
      setHistory((h) => [...h, { role: "agent", text: reply }]);
    } catch (err) {
      console.error(err);
      setHistory((h) => [
        ...h,
        {
          role: "agent",
          text: "Sorry, I failed to generate a reply. Check the backend.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const buildGraph = async () => {
    await fetch(`${API_BASE}/api/sessions/${sessionId}/build-graph`, {
      method: "POST",
    });
    onBuildGraph();
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">Team Conversation (Simulated)</div>
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
              (m.role === "user"
                ? "chat-message-user"
                : "chat-message-agent")
            }
          >
            <span className="chat-message-label">
              {m.role === "user" ? "Team Member" : "Nema Agent"}
            </span>
            <span>{m.text}</span>
          </div>
        ))}
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          placeholder="Ask Nema about PTO, performance reviews, meetings..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
        />
        <button
          className="chat-send-button"
          onClick={sendMessage}
          disabled={isSending}
        >
          {isSending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
};


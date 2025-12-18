import React, { useEffect, useRef, useState } from "react";

type Turn = { role: "user" | "assistant"; text: string };

const REALTIME_WS = "ws://localhost:4000";

export const RealtimeGraphChat: React.FC = () => {
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(REALTIME_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = (e) => {
      console.error("Realtime WS error:", e);
      setError("Realtime connection error.");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "assistant_text") {
          const text: string = msg.text || "";
          setHistory((h) => [...h, { role: "assistant", text }]);
        }
      } catch (err) {
        console.error("Realtime WS parse error:", err);
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const send = () => {
    const q = input.trim();
    if (!q || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setHistory((h) => [...h, { role: "user", text: q }]);
    wsRef.current.send(JSON.stringify({ type: "user_text", text: q }));
    setInput("");
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
      <div className="panel-header">
        <div>
          <div className="panel-title">Customer ↔ Nema (Realtime + Graph)</div>
          <div className="panel-subtitle">
            Answers powered by OpenAI Realtime with Nema&apos;s memory graph as
            context.
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            color: connected ? "#4ade80" : "#f97316",
          }}
        >
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>

      <div className="chat-history" style={{ flex: 1, minHeight: 0 }}>
        {history.map((turn, idx) => (
          <div
            key={idx}
            className={
              "chat-message " +
              (turn.role === "user"
                ? "chat-message-user"
                : "chat-message-agent")
            }
          >
            <span className="chat-message-label">
              {turn.role === "user" ? "Customer" : "Nema (Agent)"}
            </span>
            <span>{turn.text}</span>
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
        <input
          className="chat-input"
          placeholder="Ask Nema about products, delivery, orders..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
        />
        <button className="chat-send-button" onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
};

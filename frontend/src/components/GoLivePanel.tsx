import React, { useEffect, useState } from "react";

const ORCH_BASE =
  (import.meta as any).env?.VITE_ORCH_BASE_URL || "http://localhost:3003";

// Hard-coded display number (show ONLY after provisioning succeeds)
const PRIMARY_NUMBER_DISPLAY = "+1 206 926 3847";

export const GoLivePanel: React.FC<{ resetSignal?: number }> = ({
  resetSignal = 0,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isLive, setIsLive] = useState(false);

  // Reset UI state on account reset
  useEffect(() => {
    setError(null);
    setBusy(false);
    setIsLive(false);
  }, [resetSignal]);

  const goLive = async () => {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`${ORCH_BASE}/api/phone/go-live`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        setIsLive(false);
        setError(
          data?.error ||
            `Go live failed (${res.status}). Check orchestrator logs.`
        );
        return;
      }

      // ✅ Provisioning succeeded: reveal the hard-coded number
      setIsLive(true);
    } catch (e: any) {
      setIsLive(false);
      setError(e?.message || "Failed to fetch. Orchestrator down or CORS blocked.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid rgba(148,163,184,0.25)",
        background:
          "radial-gradient(1200px 400px at 20% 0%, rgba(56,189,248,0.12), transparent 60%), linear-gradient(180deg, rgba(2,6,23,0.9), rgba(2,6,23,0.7))",
        padding: 10,
        fontSize: 12,
        color: "#e5e7eb",
        marginTop: 8,
        marginBottom: 8,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes nemaPulse {
          0% { transform: translateY(0); box-shadow: 0 0 0 rgba(56,189,248,0.0); }
          50% { transform: translateY(-1px); box-shadow: 0 0 22px rgba(56,189,248,0.28); }
          100% { transform: translateY(0); box-shadow: 0 0 0 rgba(56,189,248,0.0); }
        }
      `}</style>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ marginBottom: 2, fontWeight: 700 }}>Go Live (Phone)</div>
          <div style={{ color: "#9ca3af", fontSize: 11, lineHeight: 1.3 }}>
            Click to (re)bind the webhook so the number routes to your local AI agent.
          </div>

          {/* ✅ Only show the number AFTER provisioning succeeds */}
          {isLive ? (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              ✅ Phone ready:{" "}
              <span style={{ fontWeight: 800, letterSpacing: 0.3 }}>
                {PRIMARY_NUMBER_DISPLAY}
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 10, fontSize: 11, color: "#94a3b8" }}>
              Not live yet. Click <b>Go Live</b> to activate.
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            onClick={goLive}
            disabled={busy}
            style={{
              borderRadius: 999,
              border: "1px solid rgba(56,189,248,0.55)",
              color: "#e0f2fe",
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 800,
              cursor: busy ? "default" : "pointer",
              background:
                "linear-gradient(135deg, rgba(56,189,248,0.22), rgba(168,85,247,0.18))",
              animation: busy ? undefined : "nemaPulse 2.4s ease-in-out infinite",
              display: "flex",
              alignItems: "center",
              gap: 8,
              whiteSpace: "nowrap",
              opacity: busy ? 0.85 : 1,
            }}
            title="Bind webhook + make the number callable"
          >
            <span style={{ filter: "drop-shadow(0 0 10px rgba(56,189,248,0.5))" }}>
              ✨
            </span>
            {busy ? "Waking Nema…" : "Go Live"}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "#f97316",
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
};

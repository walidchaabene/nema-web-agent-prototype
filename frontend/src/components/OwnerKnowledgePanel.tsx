import React, { useEffect, useRef, useState } from "react";

const API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL || "http://localhost:8000";

interface Gap {
  id: string;
  question_text: string;
  status: string;
  created_at?: number;
  filled_at?: number;
}

interface Props {
  onGraphUpdated: () => void;
  onClose: () => void;
}

type IngestStage =
  | "idle"
  | "crawling"
  | "extracting"
  | "building"
  | "saving"
  | "done"
  | "error";

export const OwnerKnowledgePanel: React.FC<Props> = ({
  onGraphUpdated,
  onClose,
}) => {
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [ingestSummary, setIngestSummary] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);

  // ✅ progress UI
  const [stage, setStage] = useState<IngestStage>("idle");
  const [stageText, setStageText] = useState<string>("");
  const [pct, setPct] = useState<number>(0);
  const tickerRef = useRef<number | null>(null);

  const [gaps, setGaps] = useState<Gap[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const clearTicker = () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current);
    tickerRef.current = null;
  };

  const startTicker = () => {
    clearTicker();

    // staged, smooth “fake” progress that matches typical ingest latency
    const timeline: Array<{ stage: IngestStage; text: string; pct: number }> = [
      { stage: "crawling", text: "Crawling website…", pct: 18 },
      { stage: "extracting", text: "Extracting pages & key info…", pct: 45 },
      { stage: "building", text: "Building memory graph (Clues → Q/A → Actions)…", pct: 72 },
      { stage: "saving", text: "Saving graph to memory…", pct: 88 },
    ];

    let idx = 0;
    setStage(timeline[idx].stage);
    setStageText(timeline[idx].text);
    setPct(timeline[idx].pct);

    tickerRef.current = window.setInterval(() => {
      idx = Math.min(idx + 1, timeline.length - 1);
      setStage(timeline[idx].stage);
      setStageText(timeline[idx].text);
      setPct(timeline[idx].pct);
    }, 2200);
  };

  const loadGaps = async () => {
    const res = await fetch(`${API_BASE}/api/gaps`);
    const data = await res.json();
    setGaps(data.gaps ?? []);
  };

  useEffect(() => {
    loadGaps();
    return () => clearTicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ingestSite = async () => {
    const url = websiteUrl.trim();
    if (!url) return;

    setIsIngesting(true);
    setIngestError(null);
    setIngestSummary(null);

    setStage("crawling");
    setStageText("Crawling website…");
    setPct(12);
    startTicker();

    try {
      const res = await fetch(`${API_BASE}/api/website/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      // backend may return either {ok:false,error} or FastAPI HTTPException {detail:...}
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        clearTicker();
        setStage("error");
        setPct(0);
        setStageText("Failed.");
        setIngestError(data?.detail || data?.error || `Ingest failed (${res.status})`);
        return;
      }

      if (!data?.ok) {
        clearTicker();
        setStage("error");
        setPct(0);
        setStageText("Failed.");
        setIngestError(data?.error || "Ingest failed");
        return;
      }

      // success
      clearTicker();
      setStage("done");
      setStageText("Done.");
      setPct(100);

      const s = data.summary || {};
      setIngestSummary(`Clues: ${s.clue_count ?? 0}, Q/A: ${s.qa_count ?? 0}`);

      onGraphUpdated();
      await loadGaps();
    } catch (e: any) {
      clearTicker();
      setStage("error");
      setPct(0);
      setStageText("Failed.");
      setIngestError(e?.message || "Ingest error");
    } finally {
      setIsIngesting(false);
      // keep “Done.” visible; if error, user sees it.
    }
  };

  const createGap = async (q: string) => {
    if (!q.trim()) return;
    await fetch(`${API_BASE}/api/gaps/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_text: q }),
    });
    loadGaps();
  };

  const fillGap = async (gap: Gap) => {
    const ans = (answers[gap.id] || "").trim();
    if (!ans) return;
    await fetch(`${API_BASE}/api/gaps/fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gap_id: gap.id, owner_answer: ans }),
    });
    setAnswers((prev) => ({ ...prev, [gap.id]: "" }));
    loadGaps();
    onGraphUpdated();
  };

  const progressColor =
    stage === "error"
      ? "rgba(248,113,113,0.85)"
      : "linear-gradient(90deg, rgba(56,189,248,0.85), rgba(168,85,247,0.65))";

  return (
    <div className="owner-drawer-content">
      <div className="owner-drawer-header">
        <div>
          <div className="owner-drawer-title">Owner Console</div>
          <div className="owner-drawer-subtitle">
            Ingest your site and teach Nema how to answer and act.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="button"
            style={{ fontSize: 11, padding: "3px 10px" }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      <div className="owner-drawer-body">
        {/* Ingest */}
        <div className="owner-section">
          <div className="owner-section-header">Website link</div>
          <div className="owner-section-caption">
            Paste your website URL. We’ll crawl and build a graph of Clues → Q/A → Actions.
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="chat-input"
              style={{ fontSize: 11 }}
              placeholder="https://your-business-site.com"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
            />
            <button
              className="button button-primary"
              onClick={ingestSite}
              disabled={isIngesting}
            >
              {isIngesting ? "Ingesting…" : "Ingest"}
            </button>
          </div>

          {/* ✅ Progress */}
          {(isIngesting || stage === "done" || stage === "error") && stage !== "idle" && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 11, color: stage === "error" ? "#fecaca" : "#a5b4fc" }}>
                  {stageText}
                </div>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>
                  {stage === "done" ? "100%" : stage === "error" ? "" : `${pct}%`}
                </div>
              </div>

              <div
                style={{
                  marginTop: 6,
                  height: 8,
                  borderRadius: 999,
                  background: "rgba(148,163,184,0.18)",
                  overflow: "hidden",
                  border: "1px solid rgba(148,163,184,0.25)",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: progressColor,
                    transition: "width 350ms ease",
                  }}
                />
              </div>
            </div>
          )}

          {ingestError && (
            <div style={{ fontSize: 11, color: "#f97316", marginTop: 8 }}>
              {ingestError}
            </div>
          )}

          {ingestSummary && (
            <div style={{ fontSize: 11, color: "#a5b4fc", marginTop: 8 }}>
              {ingestSummary}
            </div>
          )}
        </div>

        {/* Add gap */}
        <div className="owner-section">
          <div className="owner-section-header">Add a customer question</div>
          <div className="owner-section-caption">
            Seed the graph with questions you know customers ask.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="chat-input"
              style={{ fontSize: 11 }}
              placeholder="e.g. Do you offer same-day delivery?"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value;
                  createGap(val);
                  (e.target as HTMLInputElement).value = "";
                }
              }}
            />
            <button className="button">Add</button>
          </div>
        </div>

        {/* Gaps */}
        <div className="owner-section" style={{ flex: 1, minHeight: 0 }}>
          <div className="owner-section-header">Knowledge gaps</div>
          <div className="owner-section-caption">
            Fill gaps to add new Q→A paths to the graph.
          </div>

          <div className="quest-list">
            {gaps.length === 0 && (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                No gaps yet. Ingest a site or add questions above.
              </div>
            )}

            {gaps.map((g) => (
              <div key={g.id} className="quest-card">
                <div
                  style={{
                    fontSize: 10,
                    color: "#9ca3af",
                    marginBottom: 2,
                    textTransform: "uppercase",
                  }}
                >
                  {g.status}
                </div>

                <div style={{ marginBottom: 4 }}>
                  <div className="quest-label">Question</div>
                  <div>{g.question_text}</div>
                </div>

                {g.status === "filled" ? (
                  <div style={{ fontSize: 11, color: "#22c55e" }}>
                    Filled – already in graph.
                  </div>
                ) : (
                  <>
                    <div className="quest-label">Your answer</div>
                    <textarea
                      style={{
                        width: "100%",
                        minHeight: 48,
                        borderRadius: 8,
                        border: "1px solid #4b5563",
                        background: "#020617",
                        color: "#e5e7eb",
                        fontSize: 11,
                        padding: 6,
                        resize: "vertical",
                      }}
                      value={answers[g.id] ?? ""}
                      onChange={(e) =>
                        setAnswers((prev) => ({
                          ...prev,
                          [g.id]: e.target.value,
                        }))
                      }
                    />

                    <div style={{ marginTop: 4, textAlign: "right" }}>
                      <button
                        className="button button-primary"
                        style={{ fontSize: 11, padding: "3px 10px" }}
                        onClick={() => fillGap(g)}
                      >
                        Save & update graph
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

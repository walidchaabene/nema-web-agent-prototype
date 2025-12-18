import React, { useEffect, useState } from "react";
import { GraphView } from "./GraphView";
import { CorrectionPanel } from "./CorrectionPanel";
import { OwnerKnowledgePanel } from "./OwnerKnowledgePanel";
import { GoLivePanel } from "./GoLivePanel";

const API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL || "http://localhost:8000";

interface NodeData {
  id: string;
  type: string;
  label: string;
  text: string;
  intent_id?: string | null;
}

interface EdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
}

export const MemoryGraphDashboard: React.FC = () => {
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [edges, setEdges] = useState<EdgeData[]>([]);
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);

  const [showOwnerDrawer, setShowOwnerDrawer] = useState(false);
  const [busyReset, setBusyReset] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // used to reset GoLive UI state after reset
  const [resetSignal, setResetSignal] = useState(0);

  const loadGraph = async () => {
    const res = await fetch(`${API_BASE}/api/graph`);
    const data = await res.json();
    setNodes(data.nodes ?? []);
    setEdges(data.edges ?? []);
  };

  const refreshGraph = async () => {
    await loadGraph();
    setGraphRefreshKey((k) => k + 1);
  };

  useEffect(() => {
    loadGraph();
  }, []);

  const closeDrawer = () => setShowOwnerDrawer(false);

  const resetAccount = async () => {
    const ok = window.confirm(
      "Reset account?\n\nThis will permanently delete the current memory graph and start fresh."
    );
    if (!ok) return;

    setBusyReset(true);
    setResetError(null);

    try {
      const res = await fetch(`${API_BASE}/api/graph/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        setResetError(
          data?.error || `Reset failed (${res.status}). Check backend logs.`
        );
        return;
      }

      setResetSignal((x) => x + 1);
      await refreshGraph();
      closeDrawer();
    } catch (e: any) {
      setResetError(e?.message || "Reset failed (network error).");
    } finally {
      setBusyReset(false);
    }
  };

  return (
    <div className="app">
      {/* ✅ Make the dashboard a fixed viewport container so right panel can scroll internally */}
      <div className="dashboard" style={{ height: "100vh", overflow: "hidden" }}>
        <header className="dashboard-header">
          <div style={{ minWidth: 360 }}>
            <div className="dashboard-title">
              Nema Memory Lab – Sales Agent Demo
            </div>
            <div className="dashboard-subtitle">
              Middle: memory graph. Right: quests (human-in-the-loop). Owner
              console via avatar.
            </div>

            <GoLivePanel resetSignal={resetSignal} />

            {resetError && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#f97316" }}>
                {resetError}
              </div>
            )}
          </div>

          <div className="header-right" style={{ display: "flex", gap: 8 }}>
            <button className="button" onClick={refreshGraph}>
              Refresh Graph
            </button>

            <button
              className="button"
              style={{
                fontSize: 11,
                padding: "4px 10px",
                borderColor: "rgba(248,113,113,0.7)",
                color: "#fecaca",
              }}
              onClick={resetAccount}
              disabled={busyReset}
            >
              {busyReset ? "Resetting…" : "Reset account"}
            </button>

            <button
              className="profile-button"
              title="Owner console"
              onClick={() => setShowOwnerDrawer(true)}
            >
              <span role="img" aria-label="owner">
                👤
              </span>
            </button>
          </div>
        </header>

        {/* ✅ Two-column grid. Right column scrolls; page does NOT overflow */}
        <main
          className="dashboard-main"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 360px",
            gap: 12,
            alignItems: "stretch",
            height: "calc(100vh - 120px)", // header height allowance; tweak if needed
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {/* Graph panel fills available height */}
          <div style={{ minHeight: 0, overflow: "hidden" }}>
            <GraphView nodes={nodes} edges={edges} />
          </div>

          {/* ✅ Quests panel scrolls internally */}
          <div
            style={{
              minHeight: 0,
              height: "100%",
              overflowY: "auto",
              overflowX: "hidden",
              paddingRight: 6,
            }}
          >
            <CorrectionPanel
              onFeedbackSent={refreshGraph}
              refreshKey={graphRefreshKey}
            />
          </div>
        </main>
      </div>

      {showOwnerDrawer && (
        <div className="drawer-overlay" onClick={closeDrawer}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <OwnerKnowledgePanel
              onGraphUpdated={refreshGraph}
              onClose={closeDrawer}
            />
          </div>
        </div>
      )}
    </div>
  );
};

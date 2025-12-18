import React, { useMemo, useState } from "react";

interface NodeData {
  id: string;
  type: string; // clue | question | answer | action
  label: string;
  text: string;
  intent_id?: string | null;
}

interface EdgeData {
  id: string;
  source: string;
  target: string;
  type: string; // describes_context | answers | next_step
  confidence: number;
}

interface Props {
  nodes: NodeData[];
  edges: EdgeData[];
}

interface QAEntry {
  clue: NodeData;
  question: NodeData;
  answer?: NodeData;
  actions: NodeData[];
}

const SVG_WIDTH = 720;
const COL_X = { clue: 80, question: 320, answer: 560, action: 700 };
const ROW_START = 70;
const ROW_GAP = 80;
const CLUE_RADIUS = 18;
const QA_RADIUS = 14;
const ACTION_RADIUS = 10;

export const GraphView: React.FC<Props> = ({ nodes, edges }) => {
  const [activeScope, setActiveScope] = useState<"all" | string>("all");
  const [zoom, setZoom] = useState(1);

  const { clueNodes, qasByClue, allQAs, summary } = useMemo(() => {
    const byId: Record<string, NodeData> = {};
    nodes.forEach((n) => (byId[n.id] = n));

    const clueNodes = nodes.filter((n) => n.type === "clue");
    const questionNodes = nodes.filter((n) => n.type === "question");
    const answerNodes = nodes.filter((n) => n.type === "answer");
    const actionNodes = nodes.filter((n) => n.type === "action");

    const describesEdges = edges.filter((e) => e.type === "describes_context");
    const answerEdges = edges.filter((e) => e.type === "answers");
    const actionEdges = edges.filter((e) => e.type === "next_step");

    const qasByClue: Record<string, QAEntry[]> = {};
    const allQAs: QAEntry[] = [];

    for (const clue of clueNodes) {
      const qids = describesEdges
        .filter((e) => e.source === clue.id)
        .map((e) => e.target);

      const entries: QAEntry[] = [];

      for (const qid of qids) {
        const q = byId[qid];
        if (!q || q.type !== "question") continue;

        const ansEdge = answerEdges.find((e) => e.source === q.id);
        const ansNode = ansEdge ? byId[ansEdge.target] : undefined;

        const actions: NodeData[] =
          ansNode
            ? actionEdges
                .filter((e) => e.source === ansNode.id)
                .map((e) => byId[e.target])
                .filter((x): x is NodeData => Boolean(x))
            : [];

        const entry: QAEntry = { clue, question: q, answer: ansNode, actions };
        entries.push(entry);
        allQAs.push(entry);
      }

      qasByClue[clue.id] = entries;
    }

    const summary = {
      clues: clueNodes.length,
      questions: questionNodes.length,
      answers: answerNodes.length,
      actions: actionNodes.length,
      edges: edges.length,
    };

    return { clueNodes, qasByClue, allQAs, summary };
  }, [nodes, edges]);

  if (!nodes.length) {
    return (
      <div className="panel graph-panel">
        <div className="panel-header">
          <div className="panel-title">Memory Graph (Sales Agent)</div>
        </div>
        <div className="graph-section" style={{ justifyContent: "center" }}>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            No nodes yet. Ingest a website or build the graph, then click{" "}
            <strong>Refresh Graph</strong>.
          </div>
        </div>
      </div>
    );
  }

  const isAll = activeScope === "all";
  const activeClue =
    !isAll && typeof activeScope === "string"
      ? clueNodes.find((c) => c.id === activeScope) || null
      : null;

  const qas: QAEntry[] = isAll
    ? allQAs
    : activeClue
    ? qasByClue[activeClue.id] || []
    : [];

  const rowCount = Math.max(1, qas.length || 1);
  const svgHeight = ROW_START + ROW_GAP * (rowCount - 1) + 100;

  const handleZoomSlider = (value: number) => {
    const z = value / 100;
    setZoom(Math.min(1.6, Math.max(0.6, z)));
  };

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="panel graph-panel">
      <div className="panel-header">
        <div className="panel-title">Memory Graph (Sales Agent)</div>
        <div className="panel-subtitle">
          Clues {summary.clues} • Questions {summary.questions} • Answers{" "}
          {summary.answers} • Actions {summary.actions}
        </div>
      </div>

      <div className="graph-section">
        <div className="graph-controls">
          <div className="graph-scope-chips">
            <button
              className="button"
              style={{
                fontSize: 11,
                padding: "3px 10px",
                background: isAll
                  ? "rgba(56,189,248,0.18)"
                  : "rgba(15,23,42,0.6)",
                borderColor: isAll ? "#38bdf8" : "rgba(148,163,184,0.6)",
                whiteSpace: "nowrap",
              }}
              onClick={() => setActiveScope("all")}
            >
              All topics
            </button>

            {clueNodes.map((c) => (
              <button
                key={c.id}
                className="button"
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  background:
                    !isAll && activeScope === c.id
                      ? "rgba(250,204,21,0.18)"
                      : "rgba(15,23,42,0.6)",
                  borderColor:
                    !isAll && activeScope === c.id
                      ? "#facc15"
                      : "rgba(148,163,184,0.6)",
                  whiteSpace: "nowrap",
                }}
                onClick={() =>
                  setActiveScope((prev) => (prev === c.id ? "all" : c.id))
                }
              >
                {c.label || "(untitled topic)"}
              </button>
            ))}
          </div>

          <div className="graph-zoom-controls">
            <span className="graph-zoom-label">Zoom</span>
            <button
              className="button"
              style={{ padding: "2px 8px", fontSize: 10 }}
              onClick={() => handleZoomSlider(Math.max(60, zoomPercent - 10))}
            >
              –
            </button>
            <input
              type="range"
              min={60}
              max={160}
              value={zoomPercent}
              onChange={(e) =>
                handleZoomSlider(parseInt(e.target.value, 10) || 100)
              }
              className="graph-zoom-slider"
            />
            <button
              className="button"
              style={{ padding: "2px 8px", fontSize: 10 }}
              onClick={() => handleZoomSlider(Math.min(160, zoomPercent + 10))}
            >
              +
            </button>
            <span className="graph-zoom-value">{zoomPercent}%</span>
          </div>
        </div>

        <div className="graph-canvas-wrapper">
          {qas.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: "#6b7280" }}>
              No Q/A paths for this scope yet.
            </div>
          ) : (
            <div
              className="graph-canvas"
              style={{
                width: SVG_WIDTH * zoom,
                height: svgHeight * zoom,
                transform: `scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              <svg
                width={SVG_WIDTH}
                height={svgHeight}
                viewBox={`0 0 ${SVG_WIDTH} ${svgHeight}`}
              >
                {qas.map((qa, idx) => {
                  const y = ROW_START + idx * ROW_GAP;

                  const clueLabel =
                    qa.clue.label || qa.clue.text?.slice(0, 40) || "";
                  const qLabel =
                    qa.question.label || qa.question.text?.slice(0, 40) || "";
                  const aLabel =
                    qa.answer?.label || qa.answer?.text?.slice(0, 40) || "";

                  return (
                    <g key={`${qa.clue.id}-${qa.question.id}`}>
                      {/* Clue */}
                      <circle
                        cx={COL_X.clue}
                        cy={y}
                        r={CLUE_RADIUS}
                        fill="#eab308"
                      />
                      <text
                        x={COL_X.clue}
                        y={y - CLUE_RADIUS - 4}
                        textAnchor="middle"
                        fill="#e5e7eb"
                        fontSize={10}
                        fontWeight={600}
                      >
                        Clue
                      </text>
                      <text
                        x={COL_X.clue}
                        y={y + CLUE_RADIUS + 12}
                        textAnchor="middle"
                        fill="#9ca3af"
                        fontSize={9}
                      >
                        {clueLabel.length > 20
                          ? clueLabel.slice(0, 19) + "…"
                          : clueLabel}
                      </text>

                      {/* Clue -> Q */}
                      <line
                        x1={COL_X.clue + CLUE_RADIUS}
                        y1={y}
                        x2={COL_X.question - QA_RADIUS}
                        y2={y}
                        stroke="#4b5563"
                        strokeWidth={1.4}
                      />

                      {/* Question */}
                      <circle
                        cx={COL_X.question}
                        cy={y}
                        r={QA_RADIUS}
                        fill="#38bdf8"
                      />
                      <text
                        x={COL_X.question}
                        y={y - QA_RADIUS - 6}
                        textAnchor="middle"
                        fill="#e5e7eb"
                        fontSize={10}
                      >
                        Q
                      </text>
                      <text
                        x={COL_X.question}
                        y={y + QA_RADIUS + 14}
                        textAnchor="middle"
                        fill="#9ca3af"
                        fontSize={9}
                      >
                        {qLabel.length > 30
                          ? qLabel.slice(0, 29) + "…"
                          : qLabel}
                      </text>

                      {/* Q -> A */}
                      {qa.answer && (
                        <>
                          <line
                            x1={COL_X.question + QA_RADIUS}
                            y1={y}
                            x2={COL_X.answer - QA_RADIUS}
                            y2={y}
                            stroke="#4b5563"
                            strokeWidth={1.4}
                          />
                          <circle
                            cx={COL_X.answer}
                            cy={y}
                            r={QA_RADIUS}
                            fill="#22c55e"
                          />
                          <text
                            x={COL_X.answer}
                            y={y - QA_RADIUS - 6}
                            textAnchor="middle"
                            fill="#e5e7eb"
                            fontSize={10}
                          >
                            A
                          </text>
                          <text
                            x={COL_X.answer}
                            y={y + QA_RADIUS + 14}
                            textAnchor="middle"
                            fill="#9ca3af"
                            fontSize={9}
                          >
                            {aLabel.length > 30
                              ? aLabel.slice(0, 29) + "…"
                              : aLabel}
                          </text>
                        </>
                      )}

                      {/* Actions */}
                      {qa.actions.map((a, i) => {
                        const ay = y + i * 18;
                        return (
                          <g key={a.id}>
                            <line
                              x1={COL_X.answer + QA_RADIUS}
                              y1={y}
                              x2={COL_X.action - ACTION_RADIUS}
                              y2={ay}
                              stroke="#4b5563"
                              strokeWidth={1}
                              strokeDasharray="2,3"
                            />
                            <circle
                              cx={COL_X.action}
                              cy={ay}
                              r={ACTION_RADIUS}
                              fill="#a855f7"
                            />
                            <text
                              x={COL_X.action}
                              y={ay + 3}
                              textAnchor="middle"
                              fill="#f9fafb"
                              fontSize={8}
                            >
                              {(a.label || "").slice(0, 8)}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from "react";

const API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL || "http://localhost:8000";

interface Task {
  id: string;
  kind: "edge_confirmation";
  edge_id: string;
  question: string;
  answer: string;
  confidence: number;
  clue_label?: string | null;
}

interface CorrectionPanelProps {
  onFeedbackSent: () => void;
  refreshKey: number;
}

export const CorrectionPanel: React.FC<CorrectionPanelProps> = ({
  onFeedbackSent,
  refreshKey,
}) => {
  const [tasksByTopic, setTasksByTopic] = useState<Record<string, Task[]>>({});
  const [editedAnswers, setEditedAnswers] = useState<Record<string, string>>({});
  const [xp, setXp] = useState(0);
  const [savingEdgeId, setSavingEdgeId] = useState<string | null>(null);

  const loadTasks = async () => {
    const res = await fetch(`${API_BASE}/api/graph/tasks`);
    const data: Task[] = await res.json();

    const grouped: Record<string, Task[]> = {};
    const edits: Record<string, string> = {};

    data.forEach((t) => {
      const topic = t.clue_label || "Uncategorized";
      if (!grouped[topic]) grouped[topic] = [];
      grouped[topic].push(t);
      edits[t.edge_id] = t.answer || "";
    });

    setTasksByTopic(grouped);
    setEditedAnswers(edits);
  };

  useEffect(() => {
    setXp(0);
    setSavingEdgeId(null);
    setTasksByTopic({});
    setEditedAnswers({});
    loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const sendFeedback = async (task: Task, value: 1 | -1) => {
    await fetch(`${API_BASE}/api/graph/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edge_id: task.edge_id, value }),
    });

    setXp((x) => x + (value > 0 ? 10 : 5));
    await loadTasks();
    onFeedbackSent();
  };

  const saveEditedAnswer = async (task: Task) => {
    const newAnswer = (editedAnswers[task.edge_id] || "").trim();
    if (!newAnswer || newAnswer === (task.answer || "").trim()) return;

    setSavingEdgeId(task.edge_id);
    try {
      await fetch(`${API_BASE}/api/graph/update-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edge_id: task.edge_id, new_answer: newAnswer }),
      });
      await loadTasks();
      onFeedbackSent();
    } finally {
      setSavingEdgeId(null);
    }
  };

  const handleAnswerChange = (edgeId: string, value: string) => {
    setEditedAnswers((prev) => ({ ...prev, [edgeId]: value }));
  };

  const topicNames = Object.keys(tasksByTopic);

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">Nema Memory Quests</div>
          <div className="panel-subtitle">
            Help Nema learn accurate, graph-backed answers.
          </div>
        </div>
        <div className="quest-xp-badge">XP: {xp}</div>
      </div>

      <div className="quest-list">
        {topicNames.length === 0 && (
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            No quests right now. Ingest a website or add questions from the owner console.
          </div>
        )}

        {topicNames.map((topic) => {
          const topicTasks = tasksByTopic[topic] || [];
          return (
            <div
              key={topic}
              style={{
                borderRadius: 10,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.9)",
                padding: 6,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: topic === "Uncategorized" ? "#e5e7eb" : "#facc15",
                  marginBottom: 4,
                }}
              >
                {topic}{" "}
                <span style={{ marginLeft: 6, fontWeight: 400, color: "#9ca3af" }}>
                  ({topicTasks.length} Q/A to review)
                </span>
              </div>

              {topicTasks.map((t) => {
                const edited = editedAnswers[t.edge_id] ?? t.answer;
                const isDirty = edited.trim() !== (t.answer || "").trim();

                return (
                  <div key={t.id} className="quest-card">
                    <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>
                      Confidence {t.confidence.toFixed(2)}
                    </div>

                    <div className="quest-question">
                      <div className="quest-label">Question</div>
                      <div>{t.question}</div>
                    </div>

                    <div className="quest-answer">
                      <div className="quest-label">Answer (you can edit this)</div>
                      <textarea
                        style={{
                          width: "100%",
                          minHeight: 60,
                          borderRadius: 8,
                          border: "1px solid #4b5563",
                          background: "#020617",
                          color: "#e5e7eb",
                          fontSize: 11,
                          padding: 6,
                          resize: "vertical",
                        }}
                        value={edited}
                        onChange={(e) => handleAnswerChange(t.edge_id, e.target.value)}
                      />

                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 6,
                          marginTop: 4,
                        }}
                      >
                        <span style={{ fontSize: 10, color: "#9ca3af" }}>
                          Is this answer correct for this question?
                        </span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="quest-btn-yes" onClick={() => sendFeedback(t, 1)}>
                            Yes
                          </button>
                          <button className="quest-btn-no" onClick={() => sendFeedback(t, -1)}>
                            No
                          </button>
                        </div>
                      </div>

                      <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end" }}>
                        <button
                          className="button"
                          style={{
                            fontSize: 11,
                            padding: "3px 10px",
                            opacity: isDirty ? 1 : 0.4,
                            cursor: isDirty ? "pointer" : "default",
                          }}
                          disabled={!isDirty || savingEdgeId === t.edge_id}
                          onClick={() => saveEditedAnswer(t)}
                        >
                          {savingEdgeId === t.edge_id ? "Saving…" : "Save edit"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

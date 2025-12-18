import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Dict, Literal, Optional
from uuid import uuid4

NodeType = Literal["intent", "clue", "question", "answer", "action"]

GRAPH_FILE_NAME = "memory_graph.json"


@dataclass
class Node:
    id: str
    type: NodeType
    label: str
    text: str
    intent_id: Optional[str] = None
    metadata: Dict = field(default_factory=dict)
    stats: Dict[str, float] = field(
        default_factory=lambda: {"pos": 0.0, "neg": 0.0, "views": 0.0}
    )


@dataclass
class Edge:
    id: str
    source: str
    target: str
    type: str
    weight: float = 0.5
    confidence: float = 0.5
    metadata: Dict = field(default_factory=dict)


@dataclass
class MemoryGraph:
    nodes: Dict[str, Node] = field(default_factory=dict)
    edges: Dict[str, Edge] = field(default_factory=dict)

    # ----- Node helpers -----

    def add_node(self, node: Node) -> Node:
        if node.id in self.nodes:
            return self.nodes[node.id]
        self.nodes[node.id] = node
        return node

    def find_or_create_question(self, text: str, intent_id: Optional[str]) -> Node:
        norm = text.strip().lower()
        for n in self.nodes.values():
            if n.type == "question" and n.text.strip().lower() == norm:
                return n
        node = Node(
            id=str(uuid4()),
            type="question",
            label=text[:60],
            text=text,
            intent_id=intent_id,
            metadata={"created_at": time.time()},
        )
        return self.add_node(node)

    def find_or_create_answer(self, text: str, intent_id: Optional[str]) -> Node:
        norm = text.strip().lower()
        for n in self.nodes.values():
            if n.type == "answer" and n.text.strip().lower() == norm:
                return n
        node = Node(
            id=str(uuid4()),
            type="answer",
            label=text[:60],
            text=text,
            intent_id=intent_id,
            metadata={"created_at": time.time()},
        )
        return self.add_node(node)

    def find_or_create_clue(self, label: str, intent_id: Optional[str]) -> Node:
        norm = label.strip().lower()
        for n in self.nodes.values():
            if n.type == "clue" and n.label.strip().lower() == norm:
                return n
        node = Node(
            id=str(uuid4()),
            type="clue",
            label=label[:60],
            text=label,
            intent_id=intent_id,
            metadata={"created_at": time.time()},
        )
        return self.add_node(node)

    def find_or_create_action(
        self, label: str, description: str = "", intent_id: Optional[str] = None
    ) -> Node:
        norm = label.strip().lower()
        for n in self.nodes.values():
            if n.type == "action" and n.label.strip().lower() == norm:
                return n
        node = Node(
            id=str(uuid4()),
            type="action",
            label=label[:60],
            text=description or label,
            intent_id=intent_id,
            metadata={"created_at": time.time()},
        )
        return self.add_node(node)

    # ----- Edge helpers -----

    def add_edge(self, edge: Edge) -> Edge:
        if edge.id in self.edges:
            return self.edges[edge.id]
        self.edges[edge.id] = edge
        return edge

    def apply_edge_feedback(self, edge_id: str, value: int):
        """
        value: +1 (good), -1 (bad)
        Adjust edge.confidence using a squashed score from feedback.
        """
        edge = self.edges[edge_id]
        stats = edge.metadata.setdefault(
            "feedback", {"pos": 0.0, "neg": 0.0, "views": 0.0}
        )
        if value > 0:
            stats["pos"] += 1.0
        else:
            stats["neg"] += 1.0
        stats["views"] += 1.0

        score = (stats["pos"] - stats["neg"]) / max(1.0, stats["views"])
        import math

        edge.confidence = 1.0 / (1.0 + math.exp(-3 * score))


# ---------- disk persistence ----------


def _graph_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, GRAPH_FILE_NAME)


def save_graph(graph: MemoryGraph) -> None:
    path = _graph_path()
    data = {
        "nodes": [asdict(n) for n in graph.nodes.values()],
        "edges": [asdict(e) for e in graph.edges.values()],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_graph() -> MemoryGraph:
    path = _graph_path()
    g = MemoryGraph()
    if not os.path.exists(path):
        return g

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    for nd in data.get("nodes", []):
        nd.setdefault("metadata", {})
        nd.setdefault("stats", {"pos": 0.0, "neg": 0.0, "views": 0.0})
        node = Node(**nd)
        g.add_node(node)

    for ed in data.get("edges", []):
        ed.setdefault("metadata", {})
        edge = Edge(**ed)
        g.add_edge(edge)

    return g

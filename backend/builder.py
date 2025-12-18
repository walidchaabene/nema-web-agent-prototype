from typing import List, Dict
from uuid import uuid4
import time
from graph_model import MemoryGraph, Edge


def build_graph_from_session(
    transcript: List[Dict],
    intent_id: str,
    graph: MemoryGraph,
):
    """
    transcript: [{ "role": "user" | "agent", "text": str, "at": float }]

    New simple rule:
      - Every user message is treated as a question.
      - The next agent message after it is treated as the answer.
    Creates question & answer nodes + 'answers' edges.
    """
    pending_q_node = None

    for turn in transcript:
        role = turn["role"]
        text = turn["text"].strip()
        if not text:
            continue

        if role == "user":
            # Treat every user message as a question
            pending_q_node = graph.find_or_create_question(text, intent_id)

        elif role == "agent" and pending_q_node is not None:
            # First agent message after a user message is the answer
            a_node = graph.find_or_create_answer(text, intent_id)

            edge = Edge(
                id=str(uuid4()),
                source=pending_q_node.id,
                target=a_node.id,
                type="answers",
                weight=0.5,
                confidence=0.5,
                metadata={"created_at": time.time(), "intent_id": intent_id},
            )
            graph.add_edge(edge)

            # Reset until we see the next user question
            pending_q_node = None

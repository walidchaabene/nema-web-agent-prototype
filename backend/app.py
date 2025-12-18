# backend/app.py
import base64
import json
import os
import tempfile
import time
from typing import List, Literal, Dict, Optional
from uuid import uuid4

import httpx
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

from graph_model import (
    MemoryGraph,
    Edge,
    load_graph,
    save_graph,
)

# ---------- KEYS (EDIT THESE) ----------


OPENAI_API_KEY = "sk-proj-**"
FIRECRAWL_API_KEY = "fc-**"
DEFAULT_INTENT_ID = "sales-agent"
TTS_MODEL = "gpt-4o-mini-tts"               # adjust to actual TTS model


# ---------- FastAPI ----------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev only
    allow_methods=["*"],
    allow_headers=["*"],
)

GRAPH: MemoryGraph = load_graph()
SESSIONS: Dict[str, List[Dict]] = {}
GAPS: Dict[str, Dict] = {}


# ---------- Models ----------

class MessageIn(BaseModel):
    role: Literal["customer", "agent"]
    text: str


class FeedbackIn(BaseModel):
    edge_id: str
    value: Literal[1, -1]


class Task(BaseModel):
    id: str
    kind: Literal["edge_confirmation"]
    edge_id: str
    question: str
    answer: str
    confidence: float
    Clue_label: Optional[str] = None


class AnswerUpdateIn(BaseModel):
    edge_id: str
    new_answer: str


class GapCreateIn(BaseModel):
    question_text: str


class GapFillIn(BaseModel):
    gap_id: str
    owner_answer: str


class WebsiteIngestRequest(BaseModel):
    url: str


class QARequest(BaseModel):
    question: str


class QAAction(BaseModel):
    id: str
    label: str
    description: Optional[str] = None


class QAResponse(BaseModel):
    matched_question_id: Optional[str]
    matched_question: Optional[str]
    answer: Optional[str]
    confidence: float
    actions: List[QAAction]
    reason: Optional[str] = None


class QATTSResponse(BaseModel):
    answer: Optional[str]
    audio_base64: Optional[str]
    actions: List[QAAction]
    reason: Optional[str] = None


class VoiceQATTSResponse(BaseModel):
    transcript: str
    answer: Optional[str]
    audio_base64: Optional[str]
    actions: List[QAAction]
    reason: Optional[str] = None


# ---------- Helpers ----------

def get_openai_client() -> OpenAI:
    if "REPLACE_ME" in OPENAI_API_KEY or not OPENAI_API_KEY:
        raise RuntimeError("Set OPENAI_API_KEY in backend/app.py")
    return OpenAI(api_key=OPENAI_API_KEY)


def infer_Clue_from_question(q_text: str) -> str:
    q = q_text.lower()
    if "delivery" in q or "ship" in q or "shipping" in q:
        return "Delivery & shipping"
    if "price" in q or "cost" in q or "discount" in q:
        return "Pricing & discounts"
    if "refund" in q or "return" in q or "warranty" in q:
        return "Refunds & warranty"
    if "custom" in q or "bespoke" in q:
        return "Custom orders"
    return "General offering"


def seed_core_actions():
    GRAPH.find_or_create_action(
        label="Take order",
        description="Collect customer details and create a new flower order.",
        intent_id=DEFAULT_INTENT_ID,
    )
    GRAPH.find_or_create_action(
        label="Book pickup time",
        description="Schedule a pickup time for an existing or new order.",
        intent_id=DEFAULT_INTENT_ID,
    )
    GRAPH.find_or_create_action(
        label="Update order ledger",
        description="Record an order or update its status in the order ledger.",
        intent_id=DEFAULT_INTENT_ID,
    )
    save_graph(GRAPH)


seed_core_actions()


def crawl_site_with_firecrawl_v2(
    start_url: str, max_depth: int = 5, limit: int = 100
) -> Dict:
    if "REPLACE_ME" in FIRECRAWL_API_KEY or not FIRECRAWL_API_KEY:
        raise RuntimeError("Set FIRECRAWL_API_KEY in backend/app.py")

    headers = {
        "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "url": start_url,
        "maxDiscoveryDepth": max_depth,
        "limit": limit,
        "scrapeOptions": {
            "formats": ["markdown"],
            "onlyMainContent": True,
        },
    }

    start_resp = httpx.post(
        "https://api.firecrawl.dev/v2/crawl",
        headers=headers,
        json=payload,
        timeout=30.0,
    )
    start_resp.raise_for_status()
    start_data = start_resp.json()
    job_id = start_data.get("id")
    if not job_id:
        raise RuntimeError(f"Firecrawl crawl did not return id: {start_data}")

    print(f"🔥 Firecrawl v2 crawl started: id={job_id}")
    status_url = f"https://api.firecrawl.dev/v2/crawl/{job_id}"
    pages: List[Dict] = []

    while True:
        status_resp = httpx.get(status_url, headers=headers, timeout=60.0)
        status_resp.raise_for_status()
        status_data = status_resp.json()
        status = status_data.get("status")
        data_items = status_data.get("data") or []

        if isinstance(data_items, list):
            pages = []
            for item in data_items:
                if not isinstance(item, dict):
                    continue
                url = item.get("url") or item.get("metadata", {}).get("url") or ""
                meta = item.get("metadata") or {}
                title = meta.get("title") or meta.get("ogTitle") or ""
                markdown = item.get("markdown") or item.get("content") or ""
                paragraphs = [p.strip() for p in markdown.split("\n") if p.strip()]
                if not (title or paragraphs):
                    continue
                pages.append(
                    {
                        "url": url,
                        "meta_info": {"page_title": title},
                        "cards": [],
                        "paragraphs": paragraphs,
                    }
                )

        print(
            f"   Firecrawl status={status}, items={len(data_items)}, pages={len(pages)}"
        )

        if status in ("completed", "finished", "done"):
            break
        if status in ("failed", "error"):
            raise RuntimeError(f"Firecrawl crawl failed: {status_data}")

        time.sleep(2.0)

    return {"pages": pages}

def ensure_graph_has_clues_and_paths(intent_id: str = DEFAULT_INTENT_ID):
    """
    If we have questions/answers but no clue nodes / no describes_context edges,
    GraphView will show an empty canvas. This function repairs the graph by
    creating a fallback 'General' clue and connecting orphan questions to it.
    """
    global GRAPH

    # If there are already clue->question edges, we're good.
    has_cq = any(e.type == "describes_context" for e in GRAPH.edges.values())
    if has_cq:
        return

    # Collect questions
    question_nodes = [n for n in GRAPH.nodes.values() if n.type == "question"]
    if not question_nodes:
        return

    # Ensure at least one clue exists
    clue_nodes = [n for n in GRAPH.nodes.values() if n.type == "clue"]
    if clue_nodes:
        general_clue = clue_nodes[0]
    else:
        general_clue = GRAPH.find_or_create_clue("General", intent_id)

    # Connect all questions to the fallback clue (only if not already connected)
    existing_pairs = set(
        (e.source, e.target)
        for e in GRAPH.edges.values()
        if e.type == "describes_context"
    )

    for q in question_nodes:
        if (general_clue.id, q.id) in existing_pairs:
            continue
        cq_edge = Edge(
            id=str(uuid4()),
            source=general_clue.id,
            target=q.id,
            type="describes_context",
            weight=0.5,
            confidence=0.3,  # lower confidence; it's a fallback link
            metadata={
                "created_at": time.time(),
                "intent_id": intent_id,
                "source": "auto_repair",
            },
        )
        GRAPH.add_edge(cq_edge)

    # Persist repaired graph
    try:
        save_graph(GRAPH)
    except Exception:
        pass


def extract_website_knowledge(scraped_pages: dict) -> Dict:
    client = get_openai_client()

    pages = scraped_pages.get("pages", [])
    if not pages:
        raise RuntimeError("No pages scraped from website")

    chunks: List[str] = []
    for p in pages:
        title = (p.get("meta_info", {}) or {}).get("page_title") or ""
        paras = p.get("paragraphs") or []
        if not isinstance(paras, list):
            continue
        body = "\n".join(paras[:20])
        section = ""
        if title:
            section += f"# {title}\n"
        section += body
        chunks.append(section.strip())

    full_text = "\n\n---\n\n".join(chunks)
    if len(full_text) > 12000:
        full_text = full_text[:12000] + "\n\n...(truncated)..."

    system_prompt = """
You are a sales enablement system that builds a knowledge graph for a business.

You will be given TEXT extracted from the business website: page titles and paragraphs.
From this, extract:

1) ClueS (Clues) with a short label (2–5 words).
2) QAS: for each, include:
   - Clue_label (one of the Clue labels)
   - question (realistic customer question)
   - answer (concise answer based ONLY on the text)
   - action (one of: "Take order", "Book pickup time", "Update order ledger", or "")

Return STRICTLY valid JSON with this schema:

{
  "Clues": [ { "label": "Some Clue" }, ... ],
  "qas": [
    {
      "Clue_label": "Some Clue",
      "question": "Customer question...",
      "answer": "Answer text...",
      "action": "Take order"
    }
  ]
}
    """.strip()

    user_prompt = f"WEBSITE TEXT:\n\n{full_text}"

    resp = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
        max_tokens=2048,
    )

    content = resp.choices[0].message.content or ""
    try:
        struct = json.loads(content)
    except json.JSONDecodeError:
        try:
            start = content.index("{")
            end = content.rindex("}") + 1
            snippet = content[start:end]
            struct = json.loads(snippet)
        except Exception:
            raise RuntimeError(
                f"Failed to parse JSON from OpenAI ingest response: {content[:400]!r}"
            )

    struct.setdefault("Clues", [])
    struct.setdefault("qas", [])
    return struct


def route_to_graph_question(user_question: str) -> Optional[str]:
    question_nodes = [n for n in GRAPH.nodes.values() if n.type == "question"]
    if not question_nodes:
        return None

    candidates = [
        {"id": n.id, "question": n.text or n.label or ""} for n in question_nodes
    ]

    client = get_openai_client()

    system_prompt = """
You are a router for a knowledge graph of Q&A.

You will be given:
- user_question: the actual question from the user
- candidates: a list of known question nodes, each with an id and question text

You MUST choose ONE of the candidate ids that best matches the user question,
or "NONE" if none are relevant.

Return STRICTLY valid JSON:
{ "best_id": "...", "confidence": 0.0 }
    """.strip()

    payload = {
        "user_question": user_question,
        "candidates": candidates,
    }

    resp = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0.0,
        max_tokens=256,
    )

    content = resp.choices[0].message.content or ""
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        try:
            start = content.index("{")
            end = content.rindex("}") + 1
            snippet = content[start:end]
            data = json.loads(snippet)
        except Exception:
            return None

    best_id = (data.get("best_id") or "").strip()
    if not best_id or best_id.upper() == "NONE":
        return None
    if best_id not in GRAPH.nodes:
        return None
    return best_id


def reset_graph_internal():
    global GRAPH, GAPS, SESSIONS
    GRAPH = MemoryGraph()
    GAPS.clear()
    SESSIONS.clear()
    seed_core_actions()


# ---------- Basic endpoints ----------

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/graph")
def get_graph():
    return {
        "nodes": [vars(n) for n in GRAPH.nodes.values()],
        "edges": [vars(e) for e in GRAPH.edges.values()],
    }


@app.post("/api/graph/reset")
def reset_graph():
    reset_graph_internal()
    return {"ok": True}

# ---------- Nema chat wrapper (for chat + Twilio) ----------

class NemaChatRequest(BaseModel):
    sessionId: str
    message: str


class NemaChatResponse(BaseModel):
    reply: str
    action: Optional[str] = None  # "TAKE_ORDER", "BOOK_PICKUP", "NONE"


@app.post("/api/nema/chat", response_model=NemaChatResponse)
def nema_chat(body: NemaChatRequest):
    """
    Nema's brain for both chat and phone.

    Flow:
      1) Use graph QA (qa_answer) to get grounded answer + actions.
      2) Use OpenAI chat to turn that into a graceful, richer reply + an action label.

    action is one of: "TAKE_ORDER", "BOOK_PICKUP", "NONE".
    """
    # 1) Graph QA: get answer, actions, confidence, reason
    qa = qa_answer(QARequest(question=body.message))

    base_answer = qa.answer or ""
    actions = qa.actions or []
    reason = qa.reason or ""

    # Do NOT surface internal messages like "No matching question in graph"
    if "No matching question in graph" in reason:
        reason = ""

    # Heuristic: detect explicit order intent from the user's utterance
    low_msg = body.message.lower()
    order_intent = any(
        phrase in low_msg
        for phrase in [
            "order flowers",
            "place an order",
            "buy flowers",
            "buy some flowers",
            "i want to order",
            "i would like to order",
            "i would like to place an order",
            "can i place an order",
        ]
    )

    # Labels of any actions the graph suggested
    action_labels = [a.label for a in actions]
    action_labels_str = ", ".join(action_labels) if action_labels else "NONE"

    # 2) Build a prompt for the LLM
    system_prompt = """
You are Nema, a warm, thoughtful sales assistant for a flower shop.

You are given:
- The user's question.
- Facts from a memory graph (graph_answer).
- Suggested actions from the graph (graph_actions).
- A boolean flag indicating whether the user clearly wants to place an order (order_intent).

Your goals:
- Be graceful and non-abrasive.
- Use the graph facts as your primary source of truth when they exist.
- If the graph has no facts, still try to be helpful:
  - You may use general knowledge, but be honest that you are answering based on your best judgment.
  - Offer to clarify or ask followup questions instead of saying "I don't know" abruptly.
- When the user clearly wants to place an order (order_intent = true),
  or the graph suggests something like "Take order", you should gently move toward placing/confirming an order:
  - Confirm that you can help.
  - Ask at least TWO simple questions to move the order forward:
    - For example: "What occasion is it for?" and "When would you like it delivered or picked up?"
  - Keep it conversational and reassuring, not like a rigid form.

You must return JSON with:
{
  "reply": "<what you say to the user in one or two sentences>",
  "action": "<one of TAKE_ORDER | BOOK_PICKUP | NONE>"
}

Guidance:
- Use "TAKE_ORDER" when the user is clearly trying to buy/place an order, even if graph_actions is NONE.
- Use "BOOK_PICKUP" when you're guiding the user to choose a pickup time.
- Use "NONE" otherwise.

Do NOT simply restate the graph facts as a single sentence.
When order_intent is true, your reply MUST:
  - Confirm you can help
  - AND ask at least two short, concrete followup questions.
Never mention internal details like "graph answer" or "reason" explicitly.
"""

    user_prompt = f"""
User question:
{body.message}

Graph answer (may be empty):
{base_answer or "None"}

Graph actions (labels, may be NONE):
{action_labels_str or "NONE"}

order_intent flag:
{order_intent}

Graph internal reason (for you to consider, do NOT repeat literally):
{reason or "None"}
"""

    # 3) Call OpenAI to get reply + action as JSON
    try:
        completion = client.chat.completions.create(
            model="gpt-4.1-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
        )
        content = completion.choices[0].message.content or "{}"
        obj = json.loads(content)
        reply = obj.get("reply")
        action = obj.get("action")

        # Fallbacks if model omitted keys or set them to empty
        if not reply:
            reply = (
                base_answer
                or reason
                or "Let me help you think this through based on what I know."
            )

        if not action or action not in ["TAKE_ORDER", "BOOK_PICKUP", "NONE"]:
            if order_intent:
                action = "TAKE_ORDER"
            else:
                action = "NONE"

    except Exception as e:
        # Fallback if OpenAI call fails
        print("Error in nema_chat LLM:", repr(e))
        reply = (
            base_answer
            or reason
            or "Let me help you think this through based on what I know."
        )
        action = "TAKE_ORDER" if order_intent else "NONE"

    # 4) Post-processing: if we're taking an order but the reply looks too generic,
    #    append a standard follow-up question to move things forward.
    if action == "TAKE_ORDER":
        # crude heuristic: if no question marks, or only one very short sentence,
        # tack on a standard follow-up
        lower_reply = reply.lower()
        num_q = reply.count("?")
        if num_q < 2 or ("what" not in lower_reply and "when" not in lower_reply):
            extra = (
                " To get this started, could you tell me what occasion it’s for, "
                "and when you’d like the flowers delivered or picked up?"
            )
            reply = reply.rstrip()
            if not reply.endswith(".") and not reply.endswith("?"):
                reply += "."
            reply += extra

    return NemaChatResponse(reply=reply, action=action)

# ---------- Website ingest ----------

from uuid import uuid4
import time
import re
from fastapi import HTTPException

@app.post("/api/website/ingest")
def ingest_website(body: WebsiteIngestRequest):
    """
    Ingest a website and build memory graph:
      Clue --describes_context--> Question --answers--> Answer --next_step--> Action

    Fixes: if extractor doesn't emit clue_label, we derive it from question/answer
    so clue_count isn't stuck at 1 (General).
    """
    try:
        global GRAPH

        url = (body.url or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="Missing url")

        # Fresh graph + seed default actions
        GRAPH = MemoryGraph()
        try:
            seed_core_actions()  # creates Take order / Book pickup time / Update order ledger
        except Exception:
            pass

        # ---- Crawl + Extract ----
        crawl_result = crawl_site_with_firecrawl_v2(url, max_depth=5, limit=100)
        struct = extract_website_knowledge(crawl_result) or {}
        clues = struct.get("clues") or []
        qas = struct.get("qas") or []

        # ---- Helpers ----
        def norm_label(x: str) -> str:
            return re.sub(r"\s+", " ", (x or "").strip())

        def find_action_node(label: str):
            want = (label or "").strip().lower()
            if not want:
                return None
            for n in GRAPH.nodes.values():
                if getattr(n, "type", None) == "action" and (getattr(n, "label", "") or "").strip().lower() == want:
                    return n
            return None

        def derive_clue_label(q_text: str, a_text: str) -> str:
            """
            Heuristic topicization so we regain multiple clues even when extractor doesn't label.
            Tune freely; this is deterministic and works well for florist sites.
            """
            t = f"{q_text} {a_text}".lower()

            # Delivery / same-day / zip codes / area
            if any(k in t for k in ["same-day", "same day", "delivery", "deliver", "zip", "zipcode", "area", "seattle", "p.s.t", "pst", "cutoff"]):
                if "same-day" in t or "same day" in t or "cutoff" in t or "by 12" in t or "12pm" in t:
                    return "Same-Day Delivery"
                return "Delivery Area"

            # Ordering / placing order / pickup
            if any(k in t for k in ["place an order", "order", "buy", "purchase", "pickup", "pick up", "schedule", "book"]):
                if "pickup" in t or "pick up" in t:
                    return "Pickup"
                return "Ordering Process"

            # Store hours
            if any(k in t for k in ["hours", "open", "close", "closing", "opening"]):
                return "Store Hours"

            # Contact
            if any(k in t for k in ["contact", "call", "phone", "email", "hotmail", "reach you"]):
                return "Contact"

            # Pricing / price ranges
            if any(k in t for k in ["price", "$", "cost", "range", "budget"]):
                return "Pricing"

            # Products / arrangements / bouquets
            if any(k in t for k in ["bouquet", "arrangement", "flowers", "roses", "orchid", "carnation", "chrysanthemum", "designer’s choice", "designer's choice", "teleflora"]):
                return "Products & Bouquets"

            return ""  # force fallback later

        # ---- Build clue nodes ----
        clue_nodes = {}

        # 1) Create clue nodes from explicit clues list if present
        for c in clues:
            if isinstance(c, dict):
                label = norm_label(c.get("label") or c.get("text") or "")
            else:
                label = norm_label(str(c))
            if not label:
                continue
            clue_nodes[label] = GRAPH.find_or_create_clue(label, DEFAULT_INTENT_ID)

        # 2) Pre-scan QAs to create clue nodes from labels (if extractor uses different keys)
        for item in qas:
            if not isinstance(item, dict):
                continue
            lab = norm_label(
                item.get("clue_label")
                or item.get("topic")
                or item.get("category")
                or item.get("section")
                or item.get("clue")
                or ""
            )
            if lab and lab not in clue_nodes:
                clue_nodes[lab] = GRAPH.find_or_create_clue(lab, DEFAULT_INTENT_ID)

        fallback_clue = None  # only created if truly needed
        qa_count = 0

        # ---- Build Q/A paths ----
        for item in qas:
            if not isinstance(item, dict):
                continue

            q_text = norm_label(item.get("question") or "")
            a_text = norm_label(item.get("answer") or "")
            if not q_text or not a_text:
                continue

            # Try extractor label keys first
            clue_label = norm_label(
                item.get("clue_label")
                or item.get("topic")
                or item.get("category")
                or item.get("section")
                or item.get("clue")
                or ""
            )

            # If still empty, derive from content
            if not clue_label:
                clue_label = derive_clue_label(q_text, a_text)

            # Create/resolve clue node
            if clue_label:
                clue_node = clue_nodes.get(clue_label)
                if clue_node is None:
                    clue_node = GRAPH.find_or_create_clue(clue_label, DEFAULT_INTENT_ID)
                    clue_nodes[clue_label] = clue_node
            else:
                if fallback_clue is None:
                    fallback_clue = GRAPH.find_or_create_clue("General", DEFAULT_INTENT_ID)
                clue_node = fallback_clue

            # Create question/answer nodes
            q_node = GRAPH.find_or_create_question(q_text, DEFAULT_INTENT_ID)
            a_node = GRAPH.find_or_create_answer(a_text, DEFAULT_INTENT_ID)

            # Clue -> Question
            GRAPH.add_edge(
                Edge(
                    id=str(uuid4()),
                    source=clue_node.id,
                    target=q_node.id,
                    type="describes_context",
                    weight=0.5,
                    confidence=0.6 if clue_label and clue_label != "General" else 0.3,
                    metadata={
                        "created_at": time.time(),
                        "intent_id": DEFAULT_INTENT_ID,
                        "source": "website_ingest",
                        "website": url,
                    },
                )
            )

            # Question -> Answer
            GRAPH.add_edge(
                Edge(
                    id=str(uuid4()),
                    source=q_node.id,
                    target=a_node.id,
                    type="answers",
                    weight=0.5,
                    confidence=0.5,
                    metadata={
                        "created_at": time.time(),
                        "intent_id": DEFAULT_INTENT_ID,
                        "source": "website_ingest",
                        "website": url,
                    },
                )
            )

            # Answer -> Action (optional)
            action_label = norm_label(item.get("action") or "")
            if action_label:
                act_node = find_action_node(action_label)
                if act_node:
                    GRAPH.add_edge(
                        Edge(
                            id=str(uuid4()),
                            source=a_node.id,
                            target=act_node.id,
                            type="next_step",
                            weight=0.5,
                            confidence=0.5,
                            metadata={
                                "created_at": time.time(),
                                "intent_id": DEFAULT_INTENT_ID,
                                "source": "website_ingest",
                                "website": url,
                            },
                        )
                    )

            qa_count += 1

        # Persist
        try:
            save_graph(GRAPH)
        except Exception:
            pass

        clue_count = len([n for n in GRAPH.nodes.values() if getattr(n, "type", None) == "clue"])

        return {
            "ok": True,
            "summary": {"clue_count": clue_count, "qa_count": qa_count},
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Website ingest failed: {str(e)}")


# ---------- Sessions for Build/Update Graph ----------

@app.post("/api/sessions/{session_id}/message")
def add_session_message(session_id: str, msg: MessageIn):
    session = SESSIONS.setdefault(session_id, [])
    session.append({"role": msg.role, "text": msg.text, "at": time.time()})
    return {"ok": True, "len": len(session)}


@app.post("/api/sessions/{session_id}/build-graph")
def build_session_graph(session_id: str):
    transcript = SESSIONS.get(session_id, [])

    pending_q_node = None
    for turn in transcript:
        role = turn.get("role")
        text = (turn.get("text") or "").strip()
        if not text:
            continue

        if role == "customer":
            pending_q_node = GRAPH.find_or_create_question(text, DEFAULT_INTENT_ID)

        elif role == "agent" and pending_q_node is not None:
            a_node = GRAPH.find_or_create_answer(text, DEFAULT_INTENT_ID)

            qa_edge = Edge(
                id=str(uuid4()),
                source=pending_q_node.id,
                target=a_node.id,
                type="answers",
                weight=0.5,
                confidence=0.5,
                metadata={
                    "created_at": time.time(),
                    "intent_id": DEFAULT_INTENT_ID,
                    "source": "customer_session",
                },
            )
            GRAPH.add_edge(qa_edge)

            Clue_label = infer_Clue_from_question(pending_q_node.text)
            Clue_node = GRAPH.find_or_create_Clue(Clue_label, DEFAULT_INTENT_ID)

            cq_edge = Edge(
                id=str(uuid4()),
                source=Clue_node.id,
                target=pending_q_node.id,
                type="describes_context",
                weight=0.5,
                confidence=0.5,
                metadata={
                    "created_at": time.time(),
                    "intent_id": DEFAULT_INTENT_ID,
                    "source": "customer_session",
                },
            )
            GRAPH.add_edge(cq_edge)

            pending_q_node = None

    save_graph(GRAPH)
    return {"ok": True, "nodes": len(GRAPH.nodes), "edges": len(GRAPH.edges)}


# ---------- Graph QA (no audio) ----------

@app.post("/api/graph/qa-answer", response_model=QAResponse)
def qa_answer(body: QARequest):
    user_q = (body.question or "").strip()
    if not user_q:
        return QAResponse(
            matched_question_id=None,
            matched_question=None,
            answer=None,
            confidence=0.0,
            actions=[],
            reason="Empty question",
        )

    best_qid = route_to_graph_question(user_q)
    if not best_qid:
        return QAResponse(
            matched_question_id=None,
            matched_question=None,
            answer=None,
            confidence=0.0,
            actions=[],
            reason="No matching question in graph",
        )

    q_node = GRAPH.nodes.get(best_qid)
    if not q_node:
        return QAResponse(
            matched_question_id=None,
            matched_question=None,
            answer=None,
            confidence=0.0,
            actions=[],
            reason="No matching question node",
        )

    answer_edge = None
    for e in GRAPH.edges.values():
        if e.type == "answers" and e.source == q_node.id:
            answer_edge = e
            break

    if not answer_edge:
        return QAResponse(
            matched_question_id=q_node.id,
            matched_question=q_node.text,
            answer=None,
            confidence=0.0,
            actions=[],
            reason="Question has no answer node",
        )

    a_node = GRAPH.nodes.get(answer_edge.target)
    if not a_node:
        return QAResponse(
            matched_question_id=q_node.id,
            matched_question=q_node.text,
            answer=None,
            confidence=0.0,
            actions=[],
            reason="Answer node missing",
        )

    actions: List[QAAction] = []
    for e in GRAPH.edges.values():
        if e.type == "next_step" and e.source == a_node.id:
            action_node = GRAPH.nodes.get(e.target)
            if not action_node:
                continue
            actions.append(
                QAAction(
                    id=action_node.id,
                    label=action_node.label or action_node.text,
                    description=action_node.text,
                )
            )

    return QAResponse(
        matched_question_id=q_node.id,
        matched_question=q_node.text,
        answer=a_node.text,
        confidence=answer_edge.confidence,
        actions=actions,
        reason=None,
    )

# ---------- Graph context tool types ----------

class GraphContextRequest(BaseModel):
    question: str


class GraphContextAction(BaseModel):
    id: str
    label: str
    description: Optional[str] = None


class GraphContextResponse(BaseModel):
    question: str
    facts: List[str]
    actions: List[GraphContextAction]
    confidence: float
    reason: Optional[str] = None



@app.post("/api/tools/get-graph-context", response_model=GraphContextResponse)
def get_graph_context(body: GraphContextRequest):
    """
    Tool-style endpoint for Realtime agent.

    Given a user's question, return:
      - facts: list of factual statements from the graph
      - actions: suggested actions (Take order, Book pickup time, etc.)
    The model can then use this to answer in its own words.
    """
    qa = qa_answer(QARequest(question=body.question))

    facts: List[str] = []
    if qa.answer:
        # you could split into sentences, or just treat as one fact
        facts.append(qa.answer)

    # You might later extend this to pull more context from the graph,
    # e.g., related questions/answers, Clues, etc.

    ctx_actions: List[GraphContextAction] = []
    for act in qa.actions:
        ctx_actions.append(
          GraphContextAction(
            id=act.id,
            label=act.label,
            description=act.description,
          )
        )

    return GraphContextResponse(
        question=body.question,
        facts=facts,
        actions=ctx_actions,
        confidence=qa.confidence,
        reason=qa.reason,
    )

# ---------- Graph QA + HTTP TTS (text input) ----------

@app.post("/api/graph/qa-tts", response_model=QATTSResponse)
def qa_tts(body: QARequest):
    qa = qa_answer(body)
    if not qa.answer:
        return QATTSResponse(
            answer=None,
            audio_base64=None,
            actions=qa.actions,
            reason=qa.reason or "No answer in graph",
        )

    client = get_openai_client()
    try:
        speech = client.audio.speech.create(
            model=TTS_MODEL,
            voice="alloy",
            input=qa.answer,
            format="mp3",
        )
    except Exception as e:
        print("TTS error:", repr(e))
        return QATTSResponse(
            answer=qa.answer,
            audio_base64=None,
            actions=qa.actions,
            reason="TTS error; see backend logs.",
        )

    if hasattr(speech, "read"):
        audio_bytes = speech.read()
    else:
        audio_bytes = speech

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    return QATTSResponse(
        answer=qa.answer,
        audio_base64=audio_b64,
        actions=qa.actions,
        reason=None,
    )


# ---------- Voice QA + HTTP TTS (mic input) ----------

class GraphContextRequest(BaseModel):
    question: str


class GraphContextAction(BaseModel):
    id: str
    label: str
    description: Optional[str] = None


class GraphContextResponse(BaseModel):
    question: str
    facts: List[str]
    actions: List[GraphContextAction]
    confidence: float
    reason: Optional[str] = None


@app.post("/api/voice/qa-tts", response_model=VoiceQATTSResponse)
async def voice_qa_tts(file: UploadFile = File(...)):
    """
    Voice-based QA:
      1) Transcribe audio with Whisper.
      2) Run graph QA on transcript.
      3) TTS the answer with OpenAI.
    """
    client = get_openai_client()

    # 1) read audio bytes
    audio_bytes = await file.read()

    # 2) write to tmp file for Whisper
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        with open(tmp_path, "rb") as f:
            transcribed = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
            )
        transcript = (transcribed.text or "").strip()
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass

    if not transcript:
        return VoiceQATTSResponse(
            transcript="",
            answer=None,
            audio_base64=None,
            actions=[],
            reason="Unable to transcribe audio",
        )

    qa = qa_answer(QARequest(question=transcript))

    if not qa.answer:
        return VoiceQATTSResponse(
            transcript=transcript,
            answer=None,
            audio_base64=None,
            actions=qa.actions,
            reason=qa.reason or "No answer in graph",
        )

    try:
        speech = client.audio.speech.create(
            model=TTS_MODEL,
            voice="alloy",
            input=qa.answer,
            format="mp3",
        )
    except Exception as e:
        print("TTS error:", repr(e))
        return VoiceQATTSResponse(
            transcript=transcript,
            answer=qa.answer,
            audio_base64=None,
            actions=qa.actions,
            reason="TTS error; see backend logs.",
        )

    if hasattr(speech, "read"):
        audio_out = speech.read()
    else:
        audio_out = speech

    audio_b64 = base64.b64encode(audio_out).decode("utf-8")

    return VoiceQATTSResponse(
        transcript=transcript,
        answer=qa.answer,
        audio_base64=audio_b64,
        actions=qa.actions,
        reason=None,
    )


# ---------- Tasks & feedback for quests ----------

@app.get("/api/graph/tasks", response_model=List[Task])
def get_tasks():
    tasks: List[Task] = []
    describes_edges = [
        e for e in GRAPH.edges.values() if e.type == "describes_context"
    ]

    for e in GRAPH.edges.values():
        if e.type != "answers":
            continue
        q_node = GRAPH.nodes.get(e.source)
        a_node = GRAPH.nodes.get(e.target)
        if not q_node or not a_node:
            continue

        Clue_label: Optional[str] = None
        for de in describes_edges:
            if de.target == q_node.id:
                Clue_node = GRAPH.nodes.get(de.source)
                if Clue_node:
                    Clue_label = Clue_node.label or Clue_node.text
                break

        tasks.append(
            Task(
                id=e.id,
                kind="edge_confirmation",
                edge_id=e.id,
                question=q_node.text,
                answer=a_node.text,
                confidence=e.confidence,
                Clue_label=Clue_label,
            )
        )

    return tasks


@app.post("/api/graph/update-answer")
def update_answer(body: AnswerUpdateIn):
    edge = GRAPH.edges.get(body.edge_id)
    if edge is None:
        return {"ok": False, "error": "edge not found"}
    answer_node = GRAPH.nodes.get(edge.target)
    if answer_node is None:
        return {"ok": False, "error": "answer node not found"}
    new_text = body.new_answer.strip()
    if not new_text:
        return {"ok": False, "error": "empty answer"}
    answer_node.text = new_text
    answer_node.label = new_text[:60]
    save_graph(GRAPH)
    return {"ok": True}


@app.post("/api/graph/feedback")
def post_feedback(fb: FeedbackIn):
    GRAPH.apply_edge_feedback(fb.edge_id, fb.value)
    save_graph(GRAPH)
    return {"ok": True}

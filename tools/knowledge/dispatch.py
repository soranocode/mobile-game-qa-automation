"""Task-scoped memory packets. Offline only: no model, network, or game access."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

from lookup import ROOT as KNOWLEDGE_ROOT, REPO, normalize, validate

REGISTRY_PATH = REPO / "brain/agents/missions.json"
CONTRACT_PATH = REPO / "brain/agents/contract.json"
CACHE_ROOT = REPO / "brain-store/memory-packets"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def execution_roles(memory_specialist):
    return {"coordinator": "ocean-coordinator", "executor": "ocean-mcp-executor",
            "separate_executor_required": True, "coordinator_may_call_unity": False,
            "memory_specialist": memory_specialist, "memory_specialist_launch_required": False,
            "executor_policy": "Create or reuse one separate executor for the whole authorized sequence; not one per click or mission"}


def repository_path(relative, repo=REPO):
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or "\\" in relative:
        raise ValueError("Unsafe repository path")
    resolved = (repo / path).resolve()
    if not resolved.is_relative_to(repo.resolve()) or not resolved.is_file():
        raise ValueError("Missing or escaped repository file: " + relative)
    return resolved


def load_registry():
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    index = json.loads((KNOWLEDGE_ROOT / "index.json").read_text(encoding="utf-8"))
    records = {r["id"]: r for r in validate(index)}
    if registry.get("schema") != "ocean-mission-memory/1" or contract.get("schema") != "ocean-agent-contract/1":
        raise ValueError("Unsupported memory schema")
    for name, mission in registry["missions"].items():
        if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            raise ValueError("Unsafe mission ID")
        ids = mission["source_ids"]
        if not ids or len(ids) != len(set(ids)) or set(ids) - records.keys():
            raise ValueError("Missing or duplicate memory IDs: " + name)
        if len(ids) > contract["limits"]["max_cards"]:
            raise ValueError("Split the task rather than omitting dependencies: " + name)
        if mission["agent"] not in contract["specialists"]:
            raise ValueError("Unknown specialist: " + name)
        for path in mission["implementation_files"]:
            repository_path(path)
        expected = set(ids) | set(mission["implementation_files"])
        if set(mission["reviewed_sha256"]) != expected:
            raise ValueError("Incomplete review fingerprints: " + name)
        for value in mission["reviewed_sha256"].values():
            if not re.fullmatch(r"[0-9a-f]{64}", value):
                raise ValueError("Invalid review fingerprint")
    return registry, contract, records


def select_task(query, missions):
    text = normalize(query)
    exact = [name for name, m in missions.items() if text in [normalize(name), *map(normalize, m["aliases"])]]
    if len(exact) == 1:
        return exact
    if exact:
        return exact
    # Literal aliases only. No unbounded semantic expansion or default mission.
    matches = []
    for name, mission in missions.items():
        aliases = [name, *mission["aliases"]]
        if any(re.search(r"(?<!\w)" + re.escape(normalize(alias)) + r"(?!\w)", text) for alias in aliases):
            matches.append(name)
    return matches


def make_packet(name, mission, contract, records, *, repo=REPO, knowledge_root=KNOWLEDGE_ROOT):
    fingerprints = {}
    provenance = []
    for identifier in mission["source_ids"]:
        record = records[identifier]
        # Reuse the index's path validation, then enforce the supplied test/root boundary.
        relative = Path(record["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe card path")
        path = (knowledge_root / relative).resolve()
        if not path.is_relative_to(knowledge_root.resolve()):
            raise ValueError("Card escaped the knowledge root")
        fingerprints[identifier] = digest(path.read_bytes())
        provenance.append({"id": identifier, "path": path.relative_to(repo).as_posix(),
                           "index_status": record.get("status", "unknown")})
    for path in mission["implementation_files"]:
        fingerprints[path] = digest(repository_path(path, repo).read_bytes())
    changed = [key for key, value in fingerprints.items() if mission["reviewed_sha256"].get(key) != value]
    if changed:
        return {"status": "REVIEW_REQUIRED", "task": name, "agent": mission["agent"],
                "reason": "reviewed_sources_changed", "changed": changed,
                "execution_authorized": False, "packet": None}
    packet = {
        "schema": "ocean-task-packet/1", "task": name, "agent": mission["agent"],
        "execution_roles": execution_roles(mission["agent"]),
        "scope": contract["scope"], "global_rules": contract["global_rules"],
        "live_context_required": contract["live_context_required"],
        "invalidate_active_plan_on": contract["invalidate_active_plan_on"],
        "mission": mission["brief"], "entry_point": mission["entry_point"],
        "sources": provenance, "source_revision": digest(encoded(fingerprints)),
        "max_reply_chars": contract["limits"]["max_reply_chars"],
        "execution_authorized": False, "live_state_included": False,
    }
    if mission.get("preparation_entry_point"):
        packet["preparation_entry_point"] = mission["preparation_entry_point"]
    raw = encoded(packet)
    # Never truncate a stop condition or emit a partial JSON/card to meet a budget.
    if len(raw.decode("utf-8")) > contract["limits"]["max_packet_chars"]:
        return {"status": "NEEDS_SPLIT", "task": name, "agent": mission["agent"],
                "reason": "complete_packet_exceeds_budget", "execution_authorized": False, "packet": None}
    revision = digest(raw)
    baseline = sum((knowledge_root / r["path"]).stat().st_size for r in records.values())
    return {"status": "PREPARED_KNOWLEDGE_ONLY", "task": name, "agent": mission["agent"],
            "revision": revision, "packet": packet,
            "metrics": {"selected_cards": len(provenance), "indexed_cards": len(records),
                        "packet_chars": len(raw.decode("utf-8")), "packet_utf8_bytes": len(raw),
                        "all_indexed_card_utf8_bytes": baseline,
                        "measurement": "text payload only; excludes inherited instructions, tools and agent work"},
            "execution_authorized": False}


def cache_packet(result, folder=CACHE_ROOT):
    if result["status"] != "PREPARED_KNOWLEDGE_ONLY":
        return result
    packet = result["packet"]
    expected = encoded(packet)
    path = folder / result["task"] / (result["revision"] + ".json")
    hit = path.is_file() and path.read_bytes() == expected
    if not hit:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(expected)
    # Verification above is rerun even for a cache hit. Cache is not authorization or world state.
    return {**result, "cache_hit": hit, "packet_path": str(path.resolve())}


def validate_reply(text, task, mission, max_chars):
    if len(text) > max_chars:
        return {"status": "NEEDS_COMPACT_REPLY", "reply_chars": len(text), "limit": max_chars,
                "execution_authorized": False}
    try:
        value = json.loads(text)
    except ValueError:
        return {"status": "INVALID_REPLY", "reason": "expected_json", "execution_authorized": False}
    if not isinstance(value, dict) or not isinstance(value.get("task"), str):
        return {"status": "INVALID_REPLY", "reason": "expected_task_object", "execution_authorized": False}
    if not re.match(r"^" + re.escape(task) + r"(?:\W|$)", value["task"]) or value.get("entry_point") != mission["entry_point"]:
        return {"status": "INVALID_REPLY", "reason": "wrong_task_or_unreviewed_entry_point", "execution_authorized": False}
    return {"status": "ACCEPTED_MEMORY_REPLY", "reply_chars": len(text), "reply": value,
            "execution_authorized": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="?")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--packet", action="store_true", help="Include the bounded capsule, never raw cards/history")
    parser.add_argument("--prepare", action="store_true", help="Cache static knowledge locally; no Unity/MCP calls")
    parser.add_argument("--check-reply", type=Path, help="Validate a planner handoff before forwarding it; not execution permission")
    args = parser.parse_args(argv)
    registry, contract, records = load_registry()
    if args.list:
        return {"tasks": [{"task": key, "agent": value["agent"], "goal": value["brief"]["goal"]}
                          for key, value in registry["missions"].items()], "card_contents_loaded": False}
    if not args.query:
        parser.error("Provide a task or --list")
    selected = select_task(args.query, registry["missions"])
    if len(selected) != 1:
        return {"status": "AMBIGUOUS" if selected else "UNKNOWN_TASK", "candidates": selected,
                "execution_authorized": False, "card_contents_loaded": False}
    name = selected[0]
    result = make_packet(name, registry["missions"][name], contract, records)
    if args.check_reply:
        if result["status"] != "PREPARED_KNOWLEDGE_ONLY":
            result.pop("packet", None)
            return result
        return validate_reply(args.check_reply.read_text(encoding="utf-8"), name,
                              registry["missions"][name], contract["limits"]["max_reply_chars"])
    if args.prepare:
        result = cache_packet(result)
    if not args.packet:
        result.pop("packet", None)
    result["execution_roles"] = execution_roles(registry["missions"][name]["agent"])
    result["handoff"] = "Coordinator delegates Unity access to one separate ocean-mcp-executor. The agent field names a memory specialist; a ready packet needs no extra memory specialist. No gameplay authorization is granted."
    return result


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        value = main()
        print(json.dumps(value, ensure_ascii=False, indent=2))
        if value.get("status") in {"REVIEW_REQUIRED", "NEEDS_SPLIT", "UNKNOWN_TASK", "AMBIGUOUS", "NEEDS_COMPACT_REPLY", "INVALID_REPLY"}:
            raise SystemExit(2)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "INVALID_MEMORY", "error": str(exc), "execution_authorized": False}, ensure_ascii=False))
        raise SystemExit(1)

"""Read-only metadata lookup. No semantic search, network or game access."""
import argparse
import json
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / "projects/ocean-nomad/knowledge"


def normalize(value):
    return str(value).casefold().replace("ё", "е").strip()


def card_path(record):
    relative = Path(record["path"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Unsafe card path: " + record["id"])
    resolved = (ROOT / relative).resolve()
    if not resolved.is_relative_to(ROOT.resolve()):
        raise ValueError("Card escapes knowledge root: " + record["id"])
    return resolved


def validate(index):
    if index.get("schema") != "ocean-knowledge-index/1":
        raise ValueError("Unsupported index schema")
    ids, paths = set(), set()
    records = index["records"]
    for record in records:
        if record["id"] in ids:
            raise ValueError("Duplicate ID: " + record["id"])
        ids.add(record["id"])
        path = card_path(record)
        if path in paths or not path.is_file():
            raise ValueError("Duplicate or missing card: " + record["id"])
        paths.add(path)
    for record in records:
        if set(record.get("related_ids", [])) - ids:
            raise ValueError("Unknown related ID: " + record["id"])
    for name, route in index.get("routes", {}).items():
        if set(route.get("first", []) + route.get("if_needed", [])) - ids:
            raise ValueError("Unknown route ID: " + name)
    return records


def score(query, record):
    query = normalize(query)
    if query == normalize(record["id"]):
        return 1000
    aliases = [normalize(x) for x in record.get("aliases", [])]
    if query in aliases:
        return 200
    text = normalize(" ".join([record["id"], record["title"]] +
                              record.get("aliases", []) + record.get("tags", [])))
    terms = set(re.findall(r"\w+", query))
    words = set(re.findall(r"\w+", text))
    matches = len(terms & words)
    if not matches:
        return 0
    return matches * 5 + (20 if terms <= words else 0) + (10 if query in text else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="?")
    parser.add_argument("--id")
    parser.add_argument("--read", action="store_true", help="Read only the explicit --id")
    parser.add_argument("--limit", type=int, default=4, choices=range(1, 7))
    parser.add_argument("--max-chars", type=int, default=6000)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    if args.read and not args.id:
        parser.error("--read requires --id")
    if not 1 <= args.max_chars <= 10000:
        parser.error("--max-chars must be 1..10000")
    if not (args.query or args.id or args.validate):
        parser.error("Provide a query, --id or --validate")
    index = json.loads((ROOT / "index.json").read_text(encoding="utf-8"))
    records = index["records"]
    if args.validate:
        records = validate(index)
    if args.id:
        selected = [r for r in records if r["id"] == args.id]
    elif args.query:
        ranked = sorted(((score(args.query, r), r) for r in records),
                        key=lambda item: (-item[0], item[1]["id"]))
        selected = [r for weight, r in ranked if weight > 0][:args.limit]
    else:
        return {"valid": True, "records": len(records)}
    result = {"results": selected, "card_contents_loaded": False}
    if args.validate:
        result["index_valid"] = True
    if args.read and selected:
        # Bound the read itself; a changed/large file cannot flood model context.
        with card_path(selected[0]).open(encoding="utf-8") as handle:
            content = handle.read(args.max_chars + 1)
        result.update(content=content[:args.max_chars], truncated=len(content) > args.max_chars,
                      card_contents_loaded=True, character_limit=args.max_chars)
    return result


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)

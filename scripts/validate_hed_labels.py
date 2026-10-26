"""Check ElectroClean's artifact labels against a HED SCORE library schema.

This is a development-time script. It reads a HED SCORE XML schema (downloaded
from the hed-standard/hed-schemas repository, or supplied as a local file),
confirms that every label in ``electroclean/config/artifact_labels.json`` is a
node of that schema with exactly the same spelling and capitalisation, and
writes a snapshot that the offline test-suite checks against.

Usage::

    python scripts/validate_hed_labels.py                # download 2.2.0
    python scripts/validate_hed_labels.py --xml HED_score_2.2.0.xml

The labels are never changed by this script. Discrepancies are reported so that
the research team can decide what to do.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CATALOGUE = REPO / "electroclean" / "config" / "artifact_labels.json"
URL_TEMPLATE = (
    "https://raw.githubusercontent.com/hed-standard/hed-schemas/main/"
    "library_schemas/score/hedxml/HED_score_{version}.xml"
)


def _walk(node: ET.Element, path: list[str], out: dict[str, list[dict]]) -> None:
    for child in node.findall("node"):
        name_el = child.find("name")
        if name_el is None or name_el.text is None:
            continue
        name = name_el.text.strip()
        desc_el = child.find("description")
        full = path + [name]
        out.setdefault(name, []).append(
            {
                "path": "/".join(full),
                "description": (desc_el.text or "").strip() if desc_el is not None else "",
            }
        )
        _walk(child, full, out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=None, help="HED SCORE version (default: catalogue's)")
    parser.add_argument("--xml", type=Path, default=None, help="Local schema XML file")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Snapshot output (default: electroclean/config/hed_score_<version>_validation.json)",
    )
    args = parser.parse_args(argv)

    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    version = args.version or catalogue["hed_library_version"]
    if args.xml is not None:
        raw = args.xml.read_bytes()
        source = str(args.xml.name)
    else:
        url = URL_TEMPLATE.format(version=version)
        with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 (fixed https URL)
            raw = resp.read()
        source = url

    root = ET.fromstring(raw)
    schema_version = root.attrib.get("version")
    library = root.attrib.get("library")
    nodes: dict[str, list[dict]] = {}
    for schema in root.iter("schema"):
        _walk(schema, [], nodes)

    results = []
    discrepancies = []
    for entry in catalogue["labels"]:
        label = entry["label"]
        found = nodes.get(label)
        if not found:
            ci = [n for n in nodes if n.lower() == label.lower()]
            discrepancies.append(
                {
                    "value": entry["value"],
                    "label": label,
                    "problem": "not found with exact spelling" + (f"; case-insensitive match: {ci}" if ci else ""),
                }
            )
            results.append({"value": entry["value"], "label": label, "found": False})
        else:
            results.append(
                {
                    "value": entry["value"],
                    "label": label,
                    "found": True,
                    "hed_path": found[0]["path"],
                    "hed_description": found[0]["description"],
                }
            )

    requested = {e["label"] for e in catalogue["labels"]}
    other_artifact_nodes = sorted(
        n
        for n, occ in nodes.items()
        if n.endswith("-artifact") and n not in requested and "Data-artifact" in occ[0]["path"]
    )

    snapshot = {
        "schema_library": library,
        "schema_version": schema_version,
        "with_standard": root.attrib.get("withStandard"),
        "source": source,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "catalogue_id": catalogue["catalogue_id"],
        "catalogue_version": catalogue["catalogue_version"],
        "all_labels_found_exactly": not discrepancies,
        "labels": results,
        "discrepancies": discrepancies,
        "schema_artifact_terms_not_in_catalogue": other_artifact_nodes,
    }
    out = args.out or (REPO / "electroclean" / "config" / f"hed_score_{schema_version}_validation.json")
    out.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"HED {library} {schema_version}: {len(results) - len(discrepancies)}/{len(results)} labels found exactly")
    for d in discrepancies:
        print("  DISCREPANCY:", d)
    print("Schema artifact terms not in the catalogue:", ", ".join(other_artifact_nodes))
    print("Snapshot written to", out)
    return 0 if not discrepancies else 1


if __name__ == "__main__":
    sys.exit(main())

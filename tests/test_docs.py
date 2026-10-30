"""The documentation names things as they are now.

The project was called ElectroClean until 29 October 2026 and its Firebase functions were named
``ec_<operation>``; they are ``et_<operation>`` now. The only mentions of the old name left are the
branch ``claude/electroclean-web``, which exists, the CHANGELOG (versions released as ElectroClean
and the paragraph on the rename) and the handover notes' sentence on the rename.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
FUNCTIONS = REPO / "electrotag" / "web" / "firebase" / "functions" / "main.py"
NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
           "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
           "twenty-one", "twenty-two", "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven", "twenty-eight",
           "twenty-nine", "thirty"]
TEXT_SUFFIXES = {".md", ".py", ".js", ".mjs", ".html", ".css", ".yml", ".yaml", ".toml", ".txt", ".sh", ".json"}
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", "fixtures", "example_output", "vendor"}


def text_files() -> list[Path]:
    out = []
    for p in REPO.rglob("*"):
        rel = p.relative_to(REPO)
        if (p.is_file() and p.suffix in TEXT_SUFFIXES and not SKIP_DIRS & set(rel.parts)
                and not any(part.endswith(".egg-info") for part in rel.parts)):
            out.append(p)
    return out


def docs() -> list[Path]:
    return [p for p in text_files() if p.suffix == ".md"]


def test_no_file_names_the_old_ec_functions():
    old = re.compile(r"(?<![A-Za-z0-9_])ec_[a-z<]")
    found = [f"{p.relative_to(REPO)}:{i}: {line.strip()}"
             for p in text_files() if p.name != "CHANGELOG.md" and p != Path(__file__)
             for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1) if old.search(line)]
    assert found == []


def test_the_old_name_remains_only_where_it_belongs():
    allowed = ("claude/electroclean-web", "was called ElectroClean until")
    found = []
    for p in text_files():
        if p.name == "CHANGELOG.md" or p == Path(__file__):
            continue
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            rest = line
            for a in allowed:
                rest = rest.replace(a, "")
            if re.search(r"electroclean", rest, flags=re.IGNORECASE) or re.search(r"\bEC\b", rest):
                found.append(f"{p.relative_to(REPO)}:{i}: {line.strip()}")
    assert found == []


def test_the_firebase_guide_counts_the_functions_there_are():
    names = re.findall(r"^def (et_\w+)\(", FUNCTIONS.read_text(encoding="utf-8"), flags=re.MULTILINE)
    guide = (REPO / "docs" / "web" / "firebase.md").read_text(encoding="utf-8")
    said = re.search(r"lists ElectroTag's ([a-z-]+) functions, whose names start with `et_`", guide)
    assert said, "docs/web/firebase.md no longer says how many functions the console lists"
    assert said.group(1) == NUMBERS[len(names)], f"main.py defines {len(names)}: {', '.join(names)}"


@pytest.mark.parametrize("doc", ["README.md", "HANDOVER.md", "docs/developer_guide.md", "docs/testing_guide.md",
                                 "docs/web/server.md", "docs/web/firebase.md"])
def test_install_instructions_use_plain_pip_in_an_active_environment(doc):
    text = (REPO / doc).read_text(encoding="utf-8")
    assert "python -m pip install -r requirements" not in text
    assert "--no-deps -e ." not in text


def test_the_readme_says_where_the_package_comes_from_and_links_every_guide():
    text = (REPO / "README.md").read_text(encoding="utf-8")
    assert "not published on PyPI" in text
    assert 'pip install "electrotag @ git+https://github.com/faisalmushtaq/ElectroTag"' in text
    assert "source .venv/bin/activate" in text and ".venv\\Scripts\\activate" in text
    top = text[:text.index("## Trying it")]
    for guide in ("docs/web/using.md", "docs/web/admin.md", "docs/web/firebase.md", "docs/web/server.md",
                  "docs/developer_guide.md"):
        assert f"]({guide})" in top, f"the Documentation section near the top links {guide}"
    for target in re.findall(r"\]\((?!https?://|#)([^)#]+)", text):
        assert (REPO / target).exists(), target


def test_the_annotators_guide_says_who_it_is_for():
    first = (REPO / "docs" / "web" / "using.md").read_text(encoding="utf-8").split("\n\n")[1]
    assert first.startswith("This guide is for annotators.")

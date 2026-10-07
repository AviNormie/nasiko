#!/usr/bin/env python3
"""Fail when a vendored agent module has drifted from its canonical copy, or is missing.

`nasiko push` and `nasiko deploy` build an agent's image from the agent's own directory only, so
an agent cannot import a module that lives anywhere else. Shared modules therefore live once in
oss/agents/common (canonical) and are copied next to each agent's main module. This script keeps
those copies honest:

  - a copy that differs from the canonical file fails the check;
  - an agent source file that imports a vendored module, with no copy beside it, fails the check
    (the image would crash on startup with ImportError);
  - an entry in KNOWN_DIVERGENT that no longer needs to be there fails the check, so the list can
    only shrink.

Standard library only, so CI runs it without installing anything:

    python3 oss/agents/common/check_vendored.py
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parent.parent
COMMON_DIR_NAME = "common"
VENDORED_MODULES = ("telemetry.py", "nasiko_state.py")
SKIPPED_DIRECTORIES = frozenset({"node_modules", "target", ".venv", "__pycache__", ".git"})

# Copies that predate this check and carry agent-specific additions on top of the canonical file
# (a TraceparentMiddleware, an extra instrumentor). They are exempt from the equality check, and
# only from that. Reconcile one with the canonical file, then delete its line.
KNOWN_DIVERGENT: Mapping[str, frozenset[str]] = {
    "telemetry.py": frozenset(
        {
            "doc-reader/telemetry.py",
            "langchain/src/telemetry.py",
            "langgraph/src/telemetry.py",
            "translator/src/telemetry.py",
        }
    ),
}


@dataclass(frozen=True)
class Problem:
    message: str
    fix: str | None = None


def check(
    agents_dir: Path,
    modules: Iterable[str] = VENDORED_MODULES,
    known_divergent: Mapping[str, frozenset[str]] = KNOWN_DIVERGENT,
) -> list[Problem]:
    problems: list[Problem] = []
    for module in modules:
        canonical = agents_dir / COMMON_DIR_NAME / module
        if not canonical.is_file():
            problems.append(Problem(f"the canonical file {_shown(canonical)} is missing"))
            continue
        exempt = known_divergent.get(module, frozenset())
        problems += _drifted_copies(agents_dir, canonical, exempt)
        problems += _stale_exemptions(agents_dir, canonical, exempt)
        problems += _imports_without_copy(agents_dir, module)
    return problems


def _drifted_copies(agents_dir: Path, canonical: Path, exempt: frozenset[str]) -> list[Problem]:
    wanted = canonical.read_bytes()
    problems = []
    for copy in _copies(agents_dir, canonical.name):
        if _relative(agents_dir, copy) in exempt or copy.read_bytes() == wanted:
            continue
        problems.append(
            Problem(
                f"{_shown(copy)} differs from {_shown(canonical)}",
                fix=f"cp {_shown(canonical)} {_shown(copy)}",
            )
        )
    return problems


def _stale_exemptions(agents_dir: Path, canonical: Path, exempt: frozenset[str]) -> list[Problem]:
    wanted = canonical.read_bytes()
    problems = []
    for relative in sorted(exempt):
        copy = agents_dir / relative
        if not copy.is_file():
            problems.append(
                Problem(f"KNOWN_DIVERGENT lists {relative}, which does not exist; remove the entry")
            )
        elif copy.read_bytes() == wanted:
            problems.append(Problem(f"KNOWN_DIVERGENT lists {relative}, which now matches; remove the entry"))
    return problems


def _imports_without_copy(agents_dir: Path, module: str) -> list[Problem]:
    name = module.removesuffix(".py")
    imports = re.compile(rf"^\s*(?:from\s+{name}\s+import|import\s+{name}\b)", re.MULTILINE)
    canonical = agents_dir / COMMON_DIR_NAME / module
    problems = []
    for source in _python_sources(agents_dir):
        if not _imports(source, imports) or (source.parent / module).is_file():
            continue
        problems.append(
            Problem(
                f"{_shown(source)} imports {name} but {module} is not beside it; the image would not start",
                fix=f"cp {_shown(canonical)} {_shown(source.parent / module)}",
            )
        )
    return problems


def _imports(source: Path, pattern: re.Pattern[str]) -> bool:
    return pattern.search(source.read_text(encoding="utf-8", errors="replace")) is not None


def _copies(agents_dir: Path, module: str) -> list[Path]:
    return [path for path in _walk(agents_dir) if path.name == module]


def _python_sources(agents_dir: Path) -> list[Path]:
    return [path for path in _walk(agents_dir) if path.suffix == ".py"]


def _walk(agents_dir: Path) -> list[Path]:
    """Every file under the agents, minus the canonical directory and build or cache output."""
    files = []
    for directory, subdirectories, names in os.walk(agents_dir):
        subdirectories[:] = sorted(d for d in subdirectories if d not in SKIPPED_DIRECTORIES)
        if Path(directory) == agents_dir:
            subdirectories[:] = [d for d in subdirectories if d != COMMON_DIR_NAME]
        files += [Path(directory) / name for name in sorted(names)]
    return files


def _relative(agents_dir: Path, path: Path) -> str:
    return path.relative_to(agents_dir).as_posix()


def _shown(path: Path) -> str:
    """The path as the developer can paste it: relative to where they ran the script."""
    try:
        return os.path.relpath(path)
    except ValueError:  # a different drive on Windows
        return str(path)


def main() -> int:
    problems = check(AGENTS_DIR, VENDORED_MODULES, KNOWN_DIVERGENT)
    for problem in problems:
        print(f"error: {problem.message}")
        if problem.fix:
            print(f"       fix: {problem.fix}")
    if problems:
        print(f"{len(problems)} vendoring problem(s)", file=sys.stderr)
        return 1
    print("vendored agent modules match their canonical copies")
    return 0


if __name__ == "__main__":
    sys.exit(main())

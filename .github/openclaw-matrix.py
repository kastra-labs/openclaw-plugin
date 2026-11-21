"""Include stable releases published between two candidate manifest revisions."""
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.request import urlopen

MANIFEST = ".github/openclaw-host/package.json"
REGRESSION_HOSTS = ["2026.6.6", "2026.9.2", "2026.11.6"]
STABLE = re.compile(r"[1-9][0-9]{3}\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,4})")


def version_key(version):
    if not STABLE.fullmatch(version):
        raise ValueError(f"Expected a stable OpenClaw release, got {version!r}")
    return tuple(map(int, version.split(".")))


def test_hosts(previous, candidate, published):
    low, high = version_key(previous), version_key(candidate)
    if high < low:
        raise ValueError("Qualification candidate moved backwards")
    hosts = set(REGRESSION_HOSTS) | {candidate}
    hosts.update(v for v in published if STABLE.fullmatch(v) and low < version_key(v) <= high)
    return sorted(hosts, key=version_key)


if __name__ == "__main__":
    candidate = json.loads(Path(MANIFEST).read_text())["devDependencies"]["openclaw"]
    previous = candidate
    base = os.environ.get("PR_BASE_SHA") or "origin/main"
    if subprocess.check_output(["git", "ls-tree", base, "--", MANIFEST]):
        previous = json.loads(subprocess.check_output(["git", "show", f"{base}:{MANIFEST}"]))["devDependencies"]["openclaw"]

    published = []
    if previous != candidate:
        with urlopen("https://registry.npmjs.org/openclaw", timeout=30) as response:
            published = json.load(response)["versions"]
        if candidate not in published:
            raise ValueError("Candidate is absent from the public registry")
    print(json.dumps(test_hosts(previous, candidate, published)))

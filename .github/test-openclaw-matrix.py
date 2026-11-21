import runpy
from pathlib import Path

matrix = runpy.run_path(str(Path(__file__).with_name("openclaw-matrix.py")))
hosts = matrix["test_hosts"]("2026.11.6", "2026.11.10", [
    "2026.9.1", "2026.11.7", "2026.11.8-rc.1", "2026.11.10", "2026.11.11",
])
assert hosts == [*matrix["REGRESSION_HOSTS"], "2026.11.7", "2026.11.10"]

"""Hand-made interaction logs with known content, for the analytics tests and the report's look."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from electrotag.app.session.interaction_log import SCHEMA, SCHEMA_VERSION


class LogBuilder:
    """Writes a visit log event by event, with the times chosen by the test."""

    def __init__(self, path: Path, annotator: str, started: datetime, *, mode: str = "standard",
                 idle_after_s: float = 30.0, context_id: str = "") -> None:
        self.path = path
        self.started = started
        self.seq = 0
        self.lines: list[dict[str, Any]] = [{
            "type": "header", "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
            "started_at": started.isoformat(timespec="milliseconds"), "visit_id": f"{annotator}-{path.stem}",
            "annotator_id": annotator, "mode": mode, "context_id": context_id,
            "versions": {"electrotag": "test"}, "os": "test", "logging": {"pointer_hz": 5, "idle_after_s": idle_after_s},
            "screens": [{"name": "s", "geometry": [0, 0, 1920, 1080], "device_pixel_ratio": 2.0}],
        }]
        self.context: dict[str, Any] = {}

    def event(self, t: float, kind: str, /, **fields: Any) -> None:
        self.seq += 1
        wall = (self.started + timedelta(seconds=t)).isoformat(timespec="milliseconds")
        self.lines.append({"seq": self.seq, "t": t, "wall": wall, "type": kind, **self.context, **fields})

    def recording(self, t0: float, rid: str, window: int, *, duration_s: float = 60.0, n_channels: int = 22,
                  clicks: list[float] = (), annotations: list[float] = (), finish: float | None = None,
                  views: list[tuple[float, float, float]] = ()) -> None:
        """A recording window: clicks at given times, an annotation created at each time, views (t, start, length)."""
        self.context = {"recording": rid, "window_no": window}
        self.event(t0, "recording_opened", duration_s=duration_s, n_channels_shown=n_channels, sfreq=250.0,
                   resumed=False)
        self.event(t0, "viewer_ready")
        for t, start, length in views:
            self.event(t, "view", t_start=start, duration=length, ch_start=0, n_channels=n_channels, scale_factor=1.0)
        n = 0
        for t in sorted(list(clicks) + list(annotations)):
            if t in annotations:
                n += 1
                self.event(t, "mouse_release", widget="QWidget", area="eeg", button="left")
                self.event(t, "annotation_created", via="eeg_drag", n_total=n, annotations=[{"id": f"a{n}"}])
            else:
                self.event(t, "mouse_press", widget="QWidget", area="eeg", button="left")
        if finish is not None:
            self.event(finish, "recording_finished", n_annotations=n)
        self.context = {}

    def write(self, closed: str | None = "back_to_start") -> Path:
        if closed:
            last = self.lines[-1].get("t", 0.0) if len(self.lines) > 1 else 0.0
            self.event(last, "log_closed", reason=closed)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("\n".join(json.dumps(x) for x in self.lines) + "\n", encoding="utf-8")
        return self.path


def demo_logs(root: Path, annotators: tuple[str, ...] = ("A01", "A02", "A03"), recordings: int = 6) -> Path:
    """A few annotators who get faster over their recordings (for the report's look and the CLI)."""
    base = root / "interaction_logs"
    start = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
    for k, ann in enumerate(annotators):
        for visit in range(2):
            b = LogBuilder(base / f"annotator-{ann}" / f"2026100{visit + 1}T0900_standard.jsonl", ann,
                           start + timedelta(days=visit, hours=k))
            t = 0.0
            for i in range(recordings // 2):
                n = visit * (recordings // 2) + i  # position across both visits
                per = 40.0 * (0.8 ** n) * (1 + 0.15 * k)  # seconds per annotation, falling
                ann_times = [t + 5 + per * (j + 1) for j in range(6)]
                clicks = [x - per / 2 for x in ann_times]
                end = ann_times[-1] + 10
                views = [(t + 1, 0.0, 10.0)] + [(x, min(50.0, j * 10.0), 10.0) for j, x in enumerate(ann_times)]
                b.recording(t, f"sub-00{n + 1}/eeg/sub-00{n + 1}_task-rest_eeg.vhdr", i + 1, clicks=clicks,
                            annotations=ann_times, finish=end, views=views)
                t = end + 20
            b.write()
    return root

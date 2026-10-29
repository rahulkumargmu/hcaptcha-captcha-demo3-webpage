"""Metadata for collector builds without importing the optional Playwright host."""

from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
COLLECTOR_VERSION = "1.2.2"
SCHEMA_VERSION = "1.1.0"
NOT_MONITORED = {
    "pointerover/pointerout/pointerenter/pointerleave": "not requested; mouse transition events are recorded instead",
    "pointerrawupdate": "not requested; pointermove plus getCoalescedEvents() samples are recorded",
    "getPredictedEvents": "predicted samples are not collected",
    "selectstart/selectionchange/select": "not requested",
    "drag/dragover/dragenter/dragleave": "high-frequency drag events not collected; dragstart/dragend/drop are",
    "beforeunload/unload": "deliberately not registered: such listeners change back/forward-cache behaviour",
    "fullscreenchange/devicemotion/deviceorientation/gesture*": "not requested",
    "change/input inside shadow trees": "non-composed events inside shadow roots never reach the window listener",
}

"""Verify an installed wheel through Hermes discovery, not a mocked context."""
import importlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory


with TemporaryDirectory(prefix="r-ext-wheel-") as work:
    home = Path(work)
    os.environ["HERMES_HOME"] = work
    r_ext_hermes = importlib.import_module("r_ext_hermes")
    from hermes_cli.plugins import get_plugin_command_handler, get_plugin_manager

    assert r_ext_hermes.ABI_VERSION == 1
    assert r_ext_hermes.evaluate_json('{"op":"intake","action":false}') == 3
    command = "r-ext-intake"
    manager = get_plugin_manager()
    for enabled in (False, True, False):
        (home / "config.yaml").write_text(json.dumps({"plugins": {
            "enabled": ["r-ext-hermes"] if enabled else [], "disabled": [],
        }}))
        manager.discover_and_load(force=True)
        handler = get_plugin_command_handler(command)
        if not enabled:
            assert handler is None
            continue
        assert handler is not None
        assert handler('{"action":false}') == "inline"
        assert handler('{"action":true,"clear":false,"suitable":true}') == "clarify"
        assert handler('{"action":true,"clear":true,"suitable":true,"authorized":true}') == "handoff-ready"
        assert handler('{"action":true,"suitable":false}') == "unavailable"
        assert handler('malformed') == "unavailable"
    print("Hermes wheel discovery, Rust slash command, and off/on/off disposal: PASS")

#!/usr/bin/env python3
"""Checks pim_cua_bridge.py against a Cua checkout at the pinned commit, with Cua's own definitions.

    git clone https://github.com/trycua/cua /tmp/cua && git -C /tmp/cua checkout fca21937bc4e1420a23d544d11dbdf987f0266e6
    python3 -m venv /tmp/pbvenv && /tmp/pbvenv/bin/pip install grpcio-tools protobuf
    /tmp/pbvenv/bin/python deploy/cua-eval/check_protocol.py --cua /tmp/cua

It compiles cua.env.v1's .proto files with protoc (grpcio-tools) and checks, with the official
protobuf library, that every message the bridge writes decodes to the fields it means, that it
reads what spacesd's messages say, and that the golden bytes in test_pim_cua_bridge.py are the
official library's. It checks the bridge's driver tool shapes against cua-driver's published MCP
tool schemas for Linux at that commit (scripts/docs-generators/cli-specs/cua-driver-mcp-linux.json),
and the spacesd facts the hand-off rests on, in its source. It reaches no network and no machine.
Nothing of Cua's is copied into this repository.
"""

import argparse
import importlib
import json
import os
import re
import subprocess
import sys
import tempfile

PINNED = "fca21937bc4e1420a23d544d11dbdf987f0266e6"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pim_cua_bridge as bridge  # noqa: E402
import test_pim_cua_bridge as golden  # noqa: E402

failures = []


def check(condition, what):
    print(("ok    " if condition else "FAIL  ") + what)
    if not condition:
        failures.append(what)


def compile_protos(cua):
    from grpc_tools import protoc

    proto_root = os.path.join(cua, "libs", "cua", "proto")
    out = tempfile.mkdtemp()
    files = sorted(os.path.join("cua", "env", "v1", name) for name in os.listdir(os.path.join(proto_root, "cua", "env", "v1")) if name.endswith(".proto"))
    include = os.path.join(os.path.dirname(protoc.__file__), "_proto")
    if protoc.main(["protoc", "-I" + proto_root, "-I" + include, "--python_out=" + out, *files]) != 0:
        raise SystemExit("protoc failed")
    sys.path.insert(0, out)
    return {name: importlib.import_module("cua.env.v1.%s_pb2" % name) for name in ("process", "system", "stream", "common")}


def check_messages(pb):
    process, system, stream = pb["process"], pb["system"], pb["stream"]
    config = {"python": "/usr/bin/python3", "run_as": "pim-agent"}

    call = process.StartProcessRequest.FromString(bridge.start_process_request(config, ["-I", "-c", "x"], {"A": "1", "B": "2"}, "pim-call-3-abc", 30))
    check(
        (call.config.command, list(call.config.args), dict(call.config.env), call.config.cwd, call.config.user, call.config.timeout.seconds)
        == ("/usr/bin/python3", ["-I", "-c", "x"], {"A": "1", "B": "2"}, "/", "pim-agent", 30),
        "StartProcessRequest for a file call: command, args, env, cwd, user, timeout",
    )
    check((call.tag, call.keepalive_interval.seconds, call.scrollback_bytes, call.kill_on_disconnect) == ("pim-call-3-abc", 15, 4 << 20, True), "StartProcessRequest for a file call: tag, keepalive, scrollback, kill_on_disconnect")
    command = process.StartProcessRequest.FromString(bridge.start_process_request(config, ["-c", "x"], {}, "pim-exec-3-abc"))
    check((command.config.HasField("timeout"), command.kill_on_disconnect, command.tag) == (False, False, "pim-exec-3-abc"), "StartProcessRequest for a command: no time limit, detached, tagged")
    check(command.HasField("pty") is False and command.stdin is False, "StartProcessRequest: no PTY, no stdin")

    listing = process.ListProcessesRequest.FromString(bridge.list_processes_request())
    check((listing.include_exited, listing.tag_prefix) == (False, bridge.TAG_PREFIX), "ListProcessesRequest: running processes tagged pim-")
    check(stream.CloseMediaRequest.FromString(bridge.close_media_request("m-7")).media_session_id == "m-7", "CloseMediaRequest: media_session_id")

    viewer = system.CreateViewerTicketRequest.FromString(bridge.viewer_ticket_request())
    check(
        (viewer.ttl.seconds, viewer.policy, viewer.clipboard, viewer.files_root, viewer.audio_uplink)
        == (bridge.VIEWER_TTL_SECONDS, stream.SESSION_POLICY_ALLOW_ACTIVATION, False, "", False),
        "CreateViewerTicketRequest: five minutes, interactive, no clipboard, files or microphone",
    )
    check((viewer.principal.id, viewer.principal.kind) == ("pim-owner", pb["common"].PRINCIPAL_KIND_HUMAN), "CreateViewerTicketRequest: the person, as a human")

    # What spacesd says, as the official library writes it, read the bridge's way.
    running = process.ListProcessesResponse(
        processes=[
            process.ProcessInfo(pid=1, tag="pim-exec-3-a", state=process.PROCESS_STATE_RUNNING),
            process.ProcessInfo(pid=2, tag="someone-else", state=process.PROCESS_STATE_RUNNING),
            process.ProcessInfo(pid=3, tag="pim-call-3-b", state=process.PROCESS_STATE_RUNNING),
        ]
    ).SerializeToString()

    class Lists:
        def grpc(self, method, message, timeout):
            assert method == "cua.env.v1.ProcessService/ListProcesses"
            yield running

    check(bridge.running_agent_processes(Lists()) == 2, "ListProcessesResponse: the bridge counts its own running processes only")

    opened = stream.OpenMediaResponse(media_session_id="ms-42", ticket="v1.media", ws_path="/media?ticket=v1.media").SerializeToString()
    body = b"\0" + len(opened).to_bytes(4, "big") + opened + b"\x80" + len(b"grpc-status:0\r\n").to_bytes(4, "big") + b"grpc-status:0\r\n"
    check(bridge.opened_media({}, body) == (True, "ms-42"), "OpenMediaResponse: the bridge reads media_session_id")

    ticket = system.CreateViewerTicketResponse(ticket="T" * 24, viewer_path="/viewer/#ticket=" + "T" * 24)
    ticket.expires_at.seconds = 1_793_000_000

    class Mints:
        def grpc(self, method, message, timeout):
            yield ticket.SerializeToString()

    check(bridge.mint_viewer(Mints()) == {"viewerPath": "/viewer/#ticket=" + "T" * 24, "expiresAt": 1_793_000_000}, "CreateViewerTicketResponse: the bridge reads viewer_path and expires_at")

    # The golden bytes the unit tests use are the official library's.
    data = process.StartProcessResponse(event=process.ProcessEvent(data=process.ProcessData(offset=300, stderr=b"warn\n"))).SerializeToString()
    end = process.StartProcessResponse(event=process.ProcessEvent(end=process.ProcessEnd(exit_code=-3, signal=process.SIGNAL_TERM, timed_out=True))).SerializeToString()
    check(data.hex() == golden.DATA_EVENT, "test golden DATA_EVENT is the official encoding")
    check(end.hex() == golden.END_EVENT, "test golden END_EVENT is the official encoding")
    check(viewer.SerializeToString().hex() == golden.VIEWER_REQUEST, "test golden VIEWER_REQUEST is the official encoding")
    check(opened.hex() == golden.OPEN_MEDIA_RESPONSE, "test golden OPEN_MEDIA_RESPONSE is the official encoding")
    check(running.hex() == golden.LIST_PROCESSES_RESPONSE, "test golden LIST_PROCESSES_RESPONSE is the official encoding")


TYPES = {str: "string", int: "integer", bool: "boolean", dict: "object", list: "array"}


def check_driver(cua):
    spec = json.load(open(os.path.join(cua, "scripts", "docs-generators", "cli-specs", "cua-driver-mcp-linux.json")))
    tools = {tool["name"]: tool for tool in spec["tools"]}
    for name, shape in bridge.DRIVER_TOOLS.items():
        schema = tools.get(name, {}).get("input_schema")
        check(schema is not None, "driver tool %s exists" % name)
        if schema is None:
            continue
        properties = schema.get("properties", {})
        for argument, rule in shape.items():
            declared = properties.get(argument)
            check(declared is not None, "%s.%s is one of its arguments" % (name, argument))
            if declared is None:
                continue
            check(declared.get("type") == TYPES[rule["type"]], "%s.%s is %s" % (name, argument, declared.get("type")))
            allowed = [rule["fixed"]] if "fixed" in rule else list(rule.get("one_of", ()))
            for value in allowed:
                if "enum" in declared:
                    check(value in declared["enum"], "%s.%s may be %s" % (name, argument, json.dumps(value)))
                if isinstance(value, dict):
                    nested = declared.get("properties", {})
                    check(all(key in nested and value[key] in nested[key].get("enum", [value[key]]) for key in value), "%s.%s %s fits its schema" % (name, argument, json.dumps(value)))
                    check(all(key in value for key in declared.get("required", [])), "%s.%s %s has its required fields" % (name, argument, json.dumps(value)))
        check(set(schema.get("required") or []) <= set(bridge.DRIVER_REQUIRED[name]), "%s: the bridge requires what the driver does" % name)


def check_spacesd(cua):
    """The facts about spacesd that the hand-off rests on, in its source at this commit."""
    source = lambda *parts: open(os.path.join(cua, *parts), encoding="utf-8").read()  # noqa: E731
    stream_proto = re.sub(r"\s*\n\s*//\s*", " ", source("libs", "cua", "proto", "cua", "env", "v1", "stream.proto"))
    check("an attached socket stays open past expiry" in stream_proto, "stream.proto: an attached media socket outlives its ticket (why the bridge closes sessions)")
    check("Closes a media session and revokes its ticket" in stream_proto, "stream.proto: CloseMedia closes a session and revokes its ticket")
    metadata = source("libs", "cua", "crates", "cua-proto", "src", "lib.rs")
    methods = re.search(r"VIEWER_GRPC_METHODS: &\[&str\] = &\[(.*?)\];", metadata, re.S).group(1)
    names = re.findall(r'"(/[^"]+)"', methods)
    check(not any(name.startswith(("/cua.env.v1.ComputerService/Pointer", "/cua.env.v1.ComputerService/Keyboard", "/cua.env.v1.ProcessService", "/cua.env.v1.WindowsService")) for name in names), "viewer tickets can't call input, process or window methods: input is the media session's")
    spawn = source("libs", "cua-spacesd", "crates", "cua-spacesd-server", "src", "process", "spawn.rs")
    check("command.process_group(0);" in spawn, "spacesd starts each process in a process group of its own")
    session = source("libs", "cua-spacesd", "crates", "cua-spacesd-session", "src", "media", "session.rs")
    check("viewers.is_empty() && Instant::now() > session.attach_deadline" in session, "spacesd reaps a media session nobody attached to at its attach deadline")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cua", required=True, help="a Cua checkout at %s" % PINNED)
    cua = parser.parse_args().cua
    head = subprocess.run(["git", "-C", cua, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    check(head == PINNED, "the Cua checkout is at %s" % PINNED)
    check_messages(compile_protos(cua))
    check_driver(cua)
    check_spacesd(cua)
    print("\n%d failed" % len(failures) if failures else "\nall checks passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

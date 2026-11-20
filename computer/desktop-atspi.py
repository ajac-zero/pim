#!/usr/bin/env python3
"""What Pim's desktop driver (desktop-driver.ts) reads and does through the display's accessibility bus (AT-SPI) and GDK.

One command a run: `desktop-atspi.py <command>` with its arguments as JSON on stdin, and its answer as JSON on stdout. It runs in the
display's environment (DISPLAY, XAUTHORITY, DBUS_SESSION_BUS_ADDRESS), which displayd's supervisor gives the driver.

- screenshot {quality}: the whole screen as a JPEG, base64.
- apps {}: the apps on the accessibility bus, with their pids and top-level windows.
- tree {pid, title?, limit}: the elements of one of an app's windows (the one titled `title`, else the active or first one), each with
  the path of child indexes that leads to it from the app, so a later command finds it again.
- act {pid, path, role, name, op, value?}: does `op` to the element at `path` (press, focus, set_text, set_value, extents), refusing
  when the element there is no longer the one that was read (its role or name changed).
"""
import base64
import json
import sys
import warnings

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

# Each interface is called through its own class (Atspi.Text.get_text(el, ...)): the same names on the element are deprecated aliases.
warnings.simplefilter("ignore", DeprecationWarning)

# An element's states worth telling the agent.
STATES = {
    Atspi.StateType.FOCUSED: "focused",
    Atspi.StateType.SELECTED: "selected",
    Atspi.StateType.CHECKED: "checked",
    Atspi.StateType.EXPANDED: "expanded",
    Atspi.StateType.EDITABLE: "editable",
    Atspi.StateType.ACTIVE: "active",
}
# Roles that only group others and say nothing themselves: left out of the list when they have no name, their children kept.
SILENT = {"filler", "panel", "section", "unknown", "redundant object", "invalid", "layered pane", "scroll pane", "viewport"}
PRESS = ("click", "press", "activate", "jump", "toggle", "open")
MAX_DEPTH = 40


def apps():
    desktop = Atspi.get_desktop(0)
    out = []
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            pid = app.get_process_id()
            windows = []
            for j in range(app.get_child_count()):
                w = app.get_child_at_index(j)
                if w is None:
                    continue
                windows.append({"index": j, "name": w.get_name() or "", "role": w.get_role_name(), "active": w.get_state_set().contains(Atspi.StateType.ACTIVE), **box(w)})
            out.append({"name": app.get_name() or "", "pid": pid, "windows": windows})
        except Exception:  # an app that went away while it was read
            continue
    return out


def app_of(pid):
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        try:
            if app is not None and app.get_process_id() == pid:
                return app
        except Exception:
            continue
    raise LookupError(f"No app with pid {pid} is on this desktop's accessibility bus.")


def box(el):
    try:
        e = el.get_extents(Atspi.CoordType.SCREEN)
        return {"x": e.x, "y": e.y, "w": e.width, "h": e.height}
    except Exception:
        return {"x": 0, "y": 0, "w": 0, "h": 0}


def text_of(el):
    """What an element holds, beyond its name: an entry's text or a slider's value."""
    try:
        if el.get_text_iface() is not None:
            # Embedded objects (a page's children, in Chromium) stand in its text as U+FFFC.
            return Atspi.Text.get_text(el, 0, min(Atspi.Text.get_character_count(el), 500)).replace("\ufffc", "").strip() or None
    except Exception:
        pass
    try:
        if el.get_value_iface() is not None:
            return str(Atspi.Value.get_current_value(el))
    except Exception:
        pass
    return None


def actions_of(el):
    try:
        return [Atspi.Action.get_action_name(el, i) for i in range(Atspi.Action.get_n_actions(el))] if el.get_action_iface() is not None else []
    except Exception:
        return []


def tree(pid, title=None, limit=400):
    app = app_of(pid)
    windows = [(j, app.get_child_at_index(j)) for j in range(app.get_child_count())]
    windows = [(j, w) for j, w in windows if w is not None]
    if not windows:
        raise LookupError(f"App {pid} has no windows.")
    chosen = None
    if title:
        chosen = next(((j, w) for j, w in windows if (w.get_name() or "") == title), None) or next(((j, w) for j, w in windows if title in (w.get_name() or "")), None)
    if chosen is None:
        chosen = next(((j, w) for j, w in windows if w.get_state_set().contains(Atspi.StateType.ACTIVE)), windows[0])
    index, window = chosen
    elements = []
    cut = False

    def walk(el, path, depth):
        nonlocal cut
        if len(elements) >= limit:
            cut = True
            return
        try:
            states = el.get_state_set()
            if not states.contains(Atspi.StateType.SHOWING) and depth > 0:
                return
            role = el.get_role_name()
            name = el.get_name() or ""
            value = text_of(el)
            if not (role in SILENT and not name and not value):
                elements.append({
                    "path": path,
                    "role": role,
                    "name": name,
                    **({"value": value} if value else {}),
                    "states": [label for state, label in STATES.items() if states.contains(state)],
                    "actions": actions_of(el),
                    **box(el),
                })
            if depth >= MAX_DEPTH:
                return
            for i in range(el.get_child_count()):
                child = el.get_child_at_index(i)
                if child is not None:
                    walk(child, path + [i], depth + 1)
        except Exception:  # an element that went away while it was read
            return

    walk(window, [index], 0)
    return {"app": app.get_name() or "", "pid": pid, "window": window.get_name() or "", "elements": elements, "cut": cut}


def resolve(pid, path, role, name):
    el = app_of(pid)
    for i in path:
        el = el.get_child_at_index(i) if el is not None and i < el.get_child_count() else None
        if el is None:
            break
    if el is None or el.get_role_name() != role or (el.get_name() or "") != name:
        raise LookupError("That element is no longer there: read the window again with desktop_read and use the new element_token.")
    return el


def act(pid, path, role, name, op, value=None):
    el = resolve(pid, path, role, name)
    if op == "extents":
        return box(el)
    if op == "press":
        names = actions_of(el)
        for wanted in PRESS:
            if wanted in names:
                Atspi.Action.do_action(el, names.index(wanted))
                return {"done": wanted}
        if names:
            Atspi.Action.do_action(el, 0)
            return {"done": names[0]}
        raise LookupError("That element has no action to press.")
    if op == "focus":
        return {"done": bool(el.get_component_iface() is not None and Atspi.Component.grab_focus(el))}
    if op == "set_text":
        if el.get_editable_text_iface() is None:
            raise LookupError("That element doesn't take text.")
        return {"done": bool(Atspi.EditableText.set_text_contents(el, value or ""))}
    if op == "set_value":
        if el.get_value_iface() is None:
            raise LookupError("That element has no value to set.")
        return {"done": bool(Atspi.Value.set_current_value(el, float(value)))}
    raise ValueError(f"Unknown op {op}")


def screenshot(quality=70):
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk

    root = Gdk.get_default_root_window()
    if root is None:
        raise RuntimeError("There is no display to look at.")
    width, height = root.get_width(), root.get_height()
    pixbuf = Gdk.pixbuf_get_from_window(root, 0, 0, width, height)
    ok, data = pixbuf.save_to_bufferv("jpeg", ["quality"], [str(quality)])
    if not ok:
        raise RuntimeError("The screen couldn't be encoded.")
    return {"width": width, "height": height, "jpeg": base64.b64encode(data).decode("ascii")}


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    args = json.loads(sys.stdin.read() or "{}")
    try:
        if command == "screenshot":
            result = screenshot(int(args.get("quality", 70)))
        elif command == "apps":
            result = apps()
        elif command == "tree":
            result = tree(int(args["pid"]), args.get("title"), int(args.get("limit", 400)))
        elif command == "act":
            result = act(int(args["pid"]), list(args["path"]), args["role"], args["name"], args["op"], args.get("value"))
        else:
            raise ValueError(f"Unknown command {command!r}")
        json.dump({"ok": result}, sys.stdout)
    except Exception as error:  # the driver shows the agent the reason
        json.dump({"error": str(error) or type(error).__name__}, sys.stdout)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Evaluates a JS expression in a Chrome DevTools Protocol target and prints
its JSON-encoded return value.

Used by winsafe.sh's webview_eval() to drive the Branches submenu directly
through the webview's own DOM/event handlers, instead of simulated mouse
clicks at screen coordinates. See webview_eval()'s comment in winsafe.sh for
why: that submenu populates asynchronously (a real round-trip to the
extension host to run `git branch`), and no amount of xdotool timing tuning
made clicking into it reliable once real screen-capture load was involved.
Evaluating JS directly in the target's own execution context sidesteps the
whole class of problem - it's the same click handler a real click would
fire, but with no dependency on X11 event delivery timing, and lets the
caller poll real application state (e.g. "has the submenu actually
populated yet") instead of guessing from screen pixels.

Usage: cdp_eval.py <websocket-debugger-url> <js-expression>
Prints the JSON-encoded result of Runtime.evaluate (returnByValue), or an
"ERROR: ..." line to stderr and exits non-zero on failure.
"""
import json
import sys

try:
    import websocket
except ImportError:
    print("ERROR: the 'websocket-client' package isn't installed - see check_prereqs in record-demo.sh", file=sys.stderr)
    sys.exit(1)

if len(sys.argv) != 3:
    print("usage: cdp_eval.py <websocket-debugger-url> <js-expression>", file=sys.stderr)
    sys.exit(1)

ws_url, expr = sys.argv[1], sys.argv[2]

try:
    ws = websocket.create_connection(ws_url, timeout=10)
    ws.send(json.dumps({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {"expression": expr, "returnByValue": True},
    }))
    while True:
        data = json.loads(ws.recv())
        if data.get("id") == 1:
            break
    ws.close()
except Exception as e:
    print(f"ERROR: CDP connection/evaluate failed: {e}", file=sys.stderr)
    sys.exit(1)

result = data.get("result", {})
if "exceptionDetails" in result:
    print(f"ERROR: JS threw: {result['exceptionDetails']}", file=sys.stderr)
    sys.exit(1)

value = result.get("result", {})
print(json.dumps(value.get("value")))

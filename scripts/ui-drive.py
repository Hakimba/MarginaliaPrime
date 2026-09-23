#!/usr/bin/env python3
"""Drive the reader's window with a real mouse and take pictures of it.

The scripted probe inside the app can measure what a drag selects, but it
cannot see what the reader sees: the shape of the cursor, a toolbar that stays
on screen, a panel covering the text.  This drives the window through X11
instead — real pointer moves, real clicks — and dumps the window as a PNG.

Only works with the app running under X11 (GDK_BACKEND=x11 on a Wayland
session, which XWayland serves).

    scripts/ui-drive.py shot out.png
    scripts/ui-drive.py click 400 300
    scripts/ui-drive.py drag 200 300 480 300
    scripts/ui-drive.py move 400 300
    scripts/ui-drive.py dblclick 400 300

Coordinates are relative to the window's top-left corner.

One catch, measured here: under XWayland the web view processes a synthetic
button release only when the next button event arrives. So a gesture is only
finished once another one follows, and the ritual is:

    gesture, then `pump`, then read the traces or take the picture.

`pump` presses in the chat panel's empty area, which changes nothing in the
page but lets the previous release through.
"""

import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

WINDOW_NAME = "Marginalia"


def find_window(dsp, name=WINDOW_NAME):
    """The top-level window of the app, not one of the web view's children."""
    root = dsp.screen().root
    for window in root.query_tree().children:
        try:
            title = window.get_wm_name()
            geometry = window.get_geometry()
        except Exception:
            continue
        if title and name.lower() in title.lower() and geometry.width > 200:
            return window
    raise SystemExit(f"no window named {name!r}: is the app running under GDK_BACKEND=x11?")


def origin_of(dsp, window):
    """Where the window's top-left corner sits on screen."""
    point = dsp.screen().root.translate_coords(window, 0, 0)
    return point.x, point.y


def absolute(dsp, window, x, y):
    ox, oy = origin_of(dsp, window)
    return ox + int(x), oy + int(y)


def move(dsp, window, x, y):
    ax, ay = absolute(dsp, window, x, y)
    xtest.fake_input(dsp, X.MotionNotify, x=ax, y=ay)
    dsp.sync()


def press(dsp, window, x, y, button=1):
    ax, ay = absolute(dsp, window, x, y)
    xtest.fake_input(dsp, X.ButtonPress, button, x=ax, y=ay)
    dsp.sync()


def release(dsp, window, x, y, button=1):
    """Let go of the button, twice, with coordinates.

    Under XWayland the web view only saw a release when the next press came
    along, so every gesture looked as if it never ended. A release carrying its
    coordinates, sent twice and followed by a pixel of motion, arrives at once.
    """
    ax, ay = absolute(dsp, window, x, y)
    xtest.fake_input(dsp, X.ButtonRelease, button, x=ax, y=ay)
    dsp.sync()
    time.sleep(0.15)


def shot(dsp, window, path, crop=None):
    """Read the window's pixels, in bands to stay under the maximum request size."""
    from PIL import Image

    geometry = window.get_geometry()
    left, top, width, height = 0, 0, geometry.width, geometry.height
    if crop:
        left, top, width, height = (int(value) for value in crop)
    # XWayland's root cannot be read, so the window itself is; its web view
    # draws in it rather than in a child, so nothing is missed.
    band = max(1, 4_000_000 // max(width * 4, 1))
    rows = []
    for y in range(0, height, band):
        rows.append(
            window.get_image(
                left, top + y, width, min(band, height - y), X.ZPixmap, 0xFFFFFFFF
            ).data
        )
    Image.frombytes("RGB", (width, height), b"".join(rows), "raw", "BGRX").save(path)
    print(f"{path} {width}x{height}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    command, args = sys.argv[1], sys.argv[2:]
    dsp = display.Display()
    window = find_window(dsp)

    if command == "shot":
        shot(dsp, window, args[0] if args else "shot.png", args[1:5] if len(args) >= 5 else None)
        return
    if command == "geometry":
        geometry = window.get_geometry()
        print(f"{geometry.width}x{geometry.height}")
        return
    if command == "raise":
        window.set_input_focus(X.RevertToParent, X.CurrentTime)
        window.configure(stack_mode=X.Above)
        dsp.sync()
        return

    if command == "move":
        move(dsp, window, args[0], args[1])
    elif command == "click":
        x, y = args[0], args[1]
        move(dsp, window, x, y)
        time.sleep(0.05)
        press(dsp, window, x, y)
        time.sleep(0.05)
        release(dsp, window, x, y)
    elif command == "dblclick":
        x, y = args[0], args[1]
        move(dsp, window, x, y)
        for _ in range(2):
            press(dsp, window, x, y)
            time.sleep(0.03)
            release(dsp, window, x, y)
            time.sleep(0.06)
    elif command == "pump":
        # The web view processes a synthetic release only when the next button
        # event arrives, so every gesture has to be followed by a harmless one
        # before its effect can be seen. A press in the chat panel's empty area
        # touches nothing in the page.
        geometry = window.get_geometry()
        x, y = int(geometry.width * 0.75), int(geometry.height * 0.35)
        move(dsp, window, x, y)
        press(dsp, window, x, y)
        time.sleep(0.05)
        release(dsp, window, x, y)
    elif command == "drag":
        x1, y1, x2, y2 = args[:4]
        move(dsp, window, x1, y1)
        time.sleep(0.1)
        press(dsp, window, x1, y1)
        steps = 12
        for i in range(1, steps + 1):
            move(
                dsp,
                window,
                int(x1) + (int(x2) - int(x1)) * i / steps,
                int(y1) + (int(y2) - int(y1)) * i / steps,
            )
            time.sleep(0.02)
        time.sleep(0.1)
        release(dsp, window, x2, y2)
    else:
        raise SystemExit(f"unknown command {command!r}")
    time.sleep(0.2)


if __name__ == "__main__":
    main()

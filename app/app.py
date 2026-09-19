"""
Self-assessment exam simulator.

Upload a "questions" PDF and its "answer key" PDF, take the exam in a faithful
an exam-style interface (highlight text, check lab values, select answers, navigate),
then submit to review your answers against the key with a % score.

Run:  python app.py   ->  http://127.0.0.1:5000
"""

from __future__ import annotations

import io
import os
import secrets
import sys
import tempfile
import threading

from flask import (Flask, request, session, redirect, url_for,
                   render_template, jsonify, send_file, abort)

from parsing.parser import ExamParser

FROZEN = getattr(sys, "frozen", False)  # running as a PyInstaller bundle
BASE = sys._MEIPASS if FROZEN else os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = (os.path.join(tempfile.gettempdir(), "sa_uploads") if FROZEN
              else os.path.join(BASE, "uploads"))
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__,
            template_folder=os.path.join(BASE, "templates"),
            static_folder=os.path.join(BASE, "static"))
app.secret_key = secrets.token_hex(16)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

# In-memory registry of parsed exams (local single-process app).
_EXAMS: dict[str, ExamParser] = {}
_META: dict[str, dict] = {}
_LATEST: dict[str, str] = {"token": None}  # most recently loaded exam
_LOCK = threading.Lock()


def _get_exam() -> ExamParser | None:
    token = session.get("exam")
    if token and token in _EXAMS:
        return _EXAMS[token]
    # Local single-user convenience: a tab with no session (refresh, new tab,
    # or a freshly opened browser) falls back to the most recent exam.
    latest = _LATEST.get("token")
    if latest and latest in _EXAMS:
        session["exam"] = latest
        return _EXAMS[latest]
    return None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/start", methods=["POST"])
def start():
    qf = request.files.get("questions")
    af = request.files.get("answers")
    if not qf or not af or qf.filename == "" or af.filename == "":
        return render_template("index.html",
                               error="Please choose both a questions PDF and an answer-key PDF."), 400
    try:
        duration = int(request.form.get("minutes", "75"))
    except ValueError:
        duration = 75
    duration = max(0, min(duration, 600))

    token = secrets.token_hex(8)
    qpath = os.path.join(UPLOAD_DIR, f"{token}_q.pdf")
    apath = os.path.join(UPLOAD_DIR, f"{token}_a.pdf")
    qf.save(qpath)
    af.save(apath)

    try:
        parser = ExamParser(qpath, apath)
        parser.parse()
    except Exception as e:  # pragma: no cover - surface parse failures to user
        return render_template(
            "index.html",
            error=f"Could not read those PDFs ({e}). Make sure they are the "
                  f"self-assessment questions and answer-key PDFs."), 400

    with _LOCK:
        _EXAMS[token] = parser
        _META[token] = {"minutes": duration}
        _LATEST["token"] = token
    session["exam"] = token
    return redirect(url_for("exam"))


@app.route("/exam")
def exam():
    if _get_exam() is None:
        return redirect(url_for("index"))
    return render_template("exam.html")


@app.route("/api/exam")
def api_exam():
    parser = _get_exam()
    if parser is None:
        return jsonify({"error": "no exam"}), 404
    data = parser.to_dict()
    token = session.get("exam")
    data["minutes"] = _META.get(token, {}).get("minutes", 75)
    data["sid"] = token  # per-exam id so the client keeps separate saved state
    return jsonify(data)


@app.route("/img/q/<int:item>")
def img_q(item: int):
    parser = _get_exam()
    if parser is None:
        abort(404)
    if item < 1 or item > len(parser.items):
        abort(404)
    png = parser.question_png(item - 1)
    return send_file(io.BytesIO(png), mimetype="image/png",
                     max_age=3600)


@app.route("/img/a/<int:item>")
def img_a(item: int):
    parser = _get_exam()
    if parser is None:
        abort(404)
    if item < 1 or item > len(parser.items):
        abort(404)
    it = parser.items[item - 1]
    if it.a_page is None:
        abort(404)
    png = parser.answer_png(item - 1)
    return send_file(io.BytesIO(png), mimetype="image/png", max_age=3600)


@app.route("/reset")
def reset():
    token = session.pop("exam", None)
    if token:
        with _LOCK:
            _EXAMS.pop(token, None)
            _META.pop(token, None)
    return redirect(url_for("index"))


def _open_browser(url: str):
    """Prefer Chrome (best-tested); fall back to the default browser."""
    import subprocess
    import webbrowser
    try:
        subprocess.run(["open", "-a", "Google Chrome", url],
                       check=True, capture_output=True)
    except Exception:
        webbrowser.open(url)


def _our_app_at(url: str) -> bool:
    """True if this exam app is already serving at url."""
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=1) as r:
            return b"Self-Assessment" in r.read(4096)
    except Exception:
        return False


def _pick_port() -> tuple[int, bool]:
    """Return (port, already_running). Skips ports held by other software
    (e.g. macOS AirPlay on 5000) and reuses a live instance of this app."""
    import socket
    for port in (5000, 5050, 5151):
        if _our_app_at(f"http://127.0.0.1:{port}/"):
            return port, True
        try:
            s = socket.socket()
            # match werkzeug's bind semantics: a loopback bind is fine even if
            # something else (e.g. macOS AirPlay) holds the wildcard port
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", port))
            s.close()
            return port, False
        except OSError:
            continue
    return 5000, False


if __name__ == "__main__":
    port, running = _pick_port()
    url = f"http://127.0.0.1:{port}"
    if running:
        # double-launched: just bring up the existing instance in the browser
        _open_browser(url)
        sys.exit(0)
    try:
        # open the browser shortly after the server starts
        threading.Timer(1.2, lambda: _open_browser(url)).start()
    except Exception:
        pass
    print(f"\n  exam simulator running at {url}\n")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)

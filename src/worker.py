import sys, json, pathlib, time, uuid, os, subprocess, traceback, math, ctypes

ctypes.windll.user32.SetProcessDPIAware()
import pythoncom, win32com.client, win32gui, win32con, win32api
from PIL import ImageGrab

ROOT = pathlib.Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"
IPC = ART / "ipc"
OUT = ROOT / "output"
for p in (ART, IPC, OUT):
    p.mkdir(exist_ok=True, parents=True)
pythoncom.CoInitialize()
app = None
loaded = False
rec = None
recfile = None


def retry_rejected(fn):
    for i in range(60):
        try:
            return fn()
        except pythoncom.com_error as e:
            if e.hresult not in (-2147418111, -2147417846):
                raise
            time.sleep(0.2)
    raise TimeoutError("COM rejected call before execution for 12 seconds")


class ComProxy:
    def __init__(self, obj):
        object.__setattr__(self, "obj", obj)

    def __getattr__(self, name):
        for i in range(60):
            try:
                value = retry_rejected(lambda: getattr(self.obj, name))
                break
            except AttributeError:
                if i == 59:
                    raise
                time.sleep(0.2)
        if hasattr(value, "_oleobj_"):
            return ComProxy(value)
        if callable(value):
            return lambda *args: wrap(retry_rejected(lambda: value(*args)))
        return wrap(value)

    def __setattr__(self, name, value):
        retry_rejected(lambda: setattr(self.obj, name, value))


def wrap(value):
    return ComProxy(value) if hasattr(value, "_oleobj_") else value


def path_allowed(value, extension=None):
    p = pathlib.Path(value).resolve()
    if not any(p.is_relative_to(r) for r in (OUT.resolve(), ART.resolve())):
        raise ValueError("File must be inside project output or artifacts directory")
    if extension and p.suffix.lower() not in extension:
        raise ValueError("Unexpected file extension")
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def method(obj, name):
    for attempt in range(30):
        try:
            return getattr(obj, name)
        except (AttributeError, pythoncom.com_error):
            time.sleep(0.2)
    raise RuntimeError("COM member unavailable before invocation: " + name)


def connected():
    if app is None:
        raise RuntimeError("Connect AutoCAD first")
    if not str(app.Version).startswith("25.1"):
        raise RuntimeError("Not AutoCAD 2026")
    return app.ActiveDocument


def focus():
    h = int(app.HWND)
    win32gui.ShowWindow(h, win32con.SW_MAXIMIZE)
    try:
        if win32gui.GetForegroundWindow() != h:
            win32com.client.Dispatch("WScript.Shell").SendKeys("%")
            win32gui.SetForegroundWindow(h)
    except Exception:
        pass
    win32api.SetCursorPos((25, 450))


def idle(timeout=45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if (
                app.GetAcadState().IsQuiescent
                and app.ActiveDocument.GetVariable("CMDACTIVE") == 0
            ):
                return
        except pythoncom.com_error:
            pass
        time.sleep(0.15)
    raise TimeoutError(
        "AutoCAD remains busy. Inspect dialogs; do not replay mutations blindly."
    )


def info():
    d = connected()
    return {
        "version": app.Version,
        "name": d.Name,
        "path": d.FullName,
        "saved": bool(d.Saved),
        "entities": d.ModelSpace.Count,
        "units": d.GetVariable("INSUNITS"),
    }


def lisp(code, timeout=90):
    d = connected()
    idle()
    f = IPC / (uuid.uuid4().hex + ".lisp-result")
    s = f.as_posix()
    expr = (
        "(progn (setq aicad_err (vl-catch-all-apply (function (lambda () "
        + code
        + ')))) (setq aicad_f (open "'
        + s
        + '" "w")) (write-line (if (vl-catch-all-error-p aicad_err) (strcat "ERROR:" (vl-catch-all-error-message aicad_err)) "OK") aicad_f) (close aicad_f) (setq aicad_f nil aicad_err nil) (princ))\n'
    )
    d.SendCommand(expr)
    end = time.monotonic() + timeout
    while not f.exists() and time.monotonic() < end:
        time.sleep(0.1)
    if not f.exists():
        raise TimeoutError(
            "Command completion unknown; inspect AutoCAD before retrying"
        )
    text = f.read_text(errors="replace").strip()
    if text != "OK":
        raise RuntimeError(text)
    idle()
    return {
        "completed": True,
        "receipt": str(f),
        "verification": "command completed; inspect geometry separately",
    }


def bridge(op, args):
    global loaded
    d = connected()
    idle()
    if not loaded:
        manifest = json.loads((ROOT / "bin/current.json").read_text())
        dll = (ROOT / "bin" / manifest["dll"]).as_posix()
        old = d.GetVariable("TRUSTEDPATHS")
        new = str(ROOT / "bin")
        try:
            d.SetVariable("TRUSTEDPATHS", old + ";" + new)
            lisp('(command "_.NETLOAD" "' + dll + '")')
        finally:
            d.SetVariable("TRUSTEDPATHS", old)
        loaded = True
    qid = uuid.uuid4().hex
    p = IPC / (qid + ".json")
    p.write_text(
        json.dumps(
            {"id": qid, "op": op, "args": args, "document": d.FullName or d.Name}
        ),
        encoding="utf-8",
    )
    manifest = json.loads((ROOT / "bin/current.json").read_text())
    d.SendCommand(manifest["command"] + '\n"' + p.as_posix() + '"\n')
    result = pathlib.Path(str(p) + ".result")
    end = time.monotonic() + 120
    while not result.exists() and time.monotonic() < end:
        time.sleep(0.08)
    if not result.exists():
        raise TimeoutError(
            "Bridge completion unknown; inspect AutoCAD, do not replay writes"
        )
    r = json.loads(result.read_text(encoding="utf-8-sig"))
    if r.get("id") != qid:
        raise RuntimeError("Mismatched receipt")
    if not r.get("ok"):
        raise RuntimeError(r.get("error", "Bridge failed"))
    time.sleep(0.2)
    return r["result"]


def execute(op, a):
    global app, loaded, rec, recfile
    if op == "connect_autocad":
        try:
            app = wrap(win32com.client.GetActiveObject("AutoCAD.Application.25.1"))
        except pythoncom.com_error:
            try:
                app = wrap(win32com.client.Dispatch("AutoCAD.Application.25.1"))
            except pythoncom.com_error as error:
                raise RuntimeError(
                    "AutoCAD 2026 COM connection failed. Run npm run doctor, verify that "
                    "the full AutoCAD 2026 installation exists, and start AutoCAD once. "
                    "AutoCAD 2018/2020 cannot replace the 2026 .NET 8 bridge. "
                    f"Original error: {error}"
                ) from error
        app.Visible = True
        idle()
        return info()
    if op == "disconnect_autocad":
        app = None
        loaded = False
        return {"disconnected": True, "autocad_closed": False}
    if op in ("get_autocad_status", "get_active_document"):
        return info()
    if op == "create_new_drawing":
        method(app.Documents, "Add")()
        time.sleep(1)
        idle()
        d = connected()
        d.SetVariable("INSUNITS", win32com.client.VARIANT(pythoncom.VT_I2, 4))
        d.SetVariable("MEASUREMENT", win32com.client.VARIANT(pythoncom.VT_I2, 1))
        d.SetVariable("SOLIDCHECK", win32com.client.VARIANT(pythoncom.VT_I2, 1))
        return info()
    if op == "open_drawing":
        p = path_allowed(a["path"], [".dwg"])
        # Reuse an already-open writable document instead of creating a read-only duplicate.
        for i in range(app.Documents.Count):
            existing = app.Documents.Item(i)
            if (
                existing.FullName
                and pathlib.Path(existing.FullName).resolve() == p
                and not existing.ReadOnly
            ):
                existing.Activate()
                idle()
                return info()
        app.Documents.Open(str(p), False)
        idle()
        return info()
    if op in ("save_drawing", "export_dwg", "export_dxf"):
        p = path_allowed(a["path"], [".dxf"] if op == "export_dxf" else [".dwg"])
        if p.exists() and not a.get("overwrite", False):
            raise FileExistsError("Output exists; explicit overwrite required")
        d = connected()
        idle()
        if op == "export_dxf":
            # Save a DXF copy through a separate in-memory database; retain native DWG document.
            return bridge("export_dxf", {"path": str(p)})
        d.SaveAs(str(p), 64)
        return {"path": str(p), "bytes": p.stat().st_size, "document": info()}
    if op == "close_drawing":
        d = connected()
        if not d.Saved and not a.get("discard", False):
            raise RuntimeError("Unsaved changes: save or explicitly discard")
        d.Close(False)
        return {"closed": True}
    if op == "undo_operation":
        return lisp('(command "_.U")')
    if op == "execute_command":
        # An advanced escape hatch; raw input is intentionally visible and never treated as verified geometry.
        d = connected()
        idle()
        d.SendCommand(a["command"].rstrip() + "\n")
        idle()
        return {
            "submitted": True,
            "verified": False,
            "instruction": "Inspect entities and dimensions; command result is not geometric proof",
        }
    if op in ("screenshot", "export_image"):
        focus()
        time.sleep(1)
        p = path_allowed(
            a.get("path", str(ART / (uuid.uuid4().hex + ".png"))), [".png"]
        )
        ImageGrab.grab(bbox=win32gui.GetWindowRect(app.HWND)).save(p)
        return {"path": str(p), "mime": "image/png"}
    if op == "export_stl":
        p = path_allowed(a["path"], [".stl"])
        if p.exists() and not a.get("overwrite", False):
            raise FileExistsError(str(p))
        hs = a["handles"]
        selection = "(setq aicad_ss (ssadd)) " + " ".join(
            '(ssadd (handent "' + h + '") aicad_ss)' for h in hs
        )
        d = connected()
        old_filedia = d.GetVariable("FILEDIA")
        d.SetVariable("FILEDIA", win32com.client.VARIANT(pythoncom.VT_I2, 0))
        try:
            lisp(
                selection
                + ' (command "_.STLOUT" aicad_ss "" "_Yes" "'
                + p.as_posix()
                + '") (setq aicad_ss nil)'
            )
        finally:
            d.SetVariable(
                "FILEDIA", win32com.client.VARIANT(pythoncom.VT_I2, old_filedia)
            )
        if not p.exists() or p.stat().st_size <= 84:
            raise RuntimeError("STL output missing or empty")
        return {"path": str(p), "bytes": p.stat().st_size}
    if op == "export_pdf":
        p = path_allowed(a["path"], [".pdf"])
        if p.exists() and not a.get("overwrite", False):
            raise FileExistsError(str(p))
        d = connected()
        layout = d.ActiveLayout
        old = {
            k: getattr(layout, k)
            for k in (
                "ConfigName",
                "CanonicalMediaName",
                "PlotType",
                "UseStandardScale",
                "StandardScale",
                "CenterPlot",
            )
        }
        bg = d.GetVariable("BACKGROUNDPLOT")
        try:
            d.SetVariable("BACKGROUNDPLOT", win32com.client.VARIANT(pythoncom.VT_I2, 0))
            layout.ConfigName = "DWG To PDF.pc3"
            layout.RefreshPlotDeviceInfo()
            media = list(layout.GetCanonicalMediaNames())
            pick = next((m for m in media if "A4" in m and "297" in m), media[0])
            layout.CanonicalMediaName = pick
            layout.PlotType = 1
            layout.UseStandardScale = True
            layout.StandardScale = 0
            layout.CenterPlot = True
            success = d.Plot.PlotToFile(str(p))
            if not success or not p.exists():
                raise RuntimeError("PDF plot failed")
            return {"path": str(p), "bytes": p.stat().st_size, "media": pick}
        finally:
            for k, v in old.items():
                try:
                    setattr(layout, k, v)
                except Exception:
                    pass
            d.SetVariable(
                "BACKGROUNDPLOT", win32com.client.VARIANT(pythoncom.VT_I2, bg)
            )
    if op == "start_recording":
        if rec and rec.poll() is None:
            raise RuntimeError("Recording already running")
        focus()
        recfile = path_allowed(
            a.get("path", str(ART / (time.strftime("%Y%m%d-%H%M%S") + ".mp4"))),
            [".mp4"],
        )
        ff = os.environ.get("AICAD_FFMPEG", "ffmpeg")
        if recfile.exists():
            raise FileExistsError("Recording exists; choose a new filename")
        rec = subprocess.Popen(
            [
                ff,
                "-y",
                "-f",
                "gdigrab",
                "-framerate",
                "10",
                "-i",
                "desktop",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "24",
                "-pix_fmt",
                "yuv420p",
                str(recfile),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=open(str(recfile) + ".log", "w"),
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        time.sleep(1)
        if rec.poll() is not None:
            raise RuntimeError("Recording failed")
        return {"recording": True, "path": str(recfile)}
    if op == "stop_recording":
        if not rec or rec.poll() is not None:
            raise RuntimeError("No active recording")
        rec.communicate(b"q", timeout=30)
        return {
            "recording": False,
            "path": str(recfile),
            "bytes": recfile.stat().st_size,
        }
    if op == "checkpoint":
        p = path_allowed(
            str(ART / "checkpoints" / (uuid.uuid4().hex + ".dwg")), [".dwg"]
        )
        return bridge(op, {"path": str(p)})
    return bridge(op, a)


for line in sys.stdin:
    try:
        q = json.loads(line)
        started = time.time()
        r = execute(q["op"], q.get("args", {}))
        result = {
            "id": q["id"],
            "ok": True,
            "result": r,
            "elapsed": time.time() - started,
        }
    except Exception as e:
        result = {
            "id": q.get("id"),
            "ok": False,
            "error": str(e),
            "type": type(e).__name__,
        }
    print(json.dumps(result, ensure_ascii=True), flush=True)
if rec and rec.poll() is None:
    rec.communicate(b"q", timeout=30)

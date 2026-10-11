# -*- coding: utf-8 -*-
"""
Lecteur VLC embarqué de ShippoTV.

La vidéo est rendue par libVLC dans une fenêtre Tk sans aucune interface VLC :
les commandes (lecture, avance, pistes audio, sous-titres, sources, épisode
suivant, zapping) sont dessinées par ShippoTV.

libVLC est cherchée dans un dossier « vlc » à côté de ShippoTV.exe (livré par
creer_exe.bat), puis dans une installation classique de VLC.
"""
import os
import queue
import sys
import threading
import time

vlc = None
_STATUS = None

BG = "#060408"
BAR = "#140c11"
LINE = "#2c2027"
FG = "#f6f2f4"
MUTED = "#b3a8ae"
ACC = "#d6375f"
ACC2 = "#f3a7bb"
FONT = "Segoe UI" if sys.platform == "win32" else "DejaVu Sans"


# --------------------------------------------------------------------------- recherche de libVLC
def _candidates(app_dir):
    names = ("libvlc.dll",) if sys.platform == "win32" else ("libvlc.so", "libvlc.so.5", "libvlc.dylib")
    dirs = [os.path.join(app_dir, "vlc"), os.path.join(app_dir, "VLC"), os.path.join(app_dir, "dist", "vlc"), app_dir]
    if sys.platform == "win32":
        for env in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
            pf = os.environ.get(env)
            if pf:
                dirs.append(os.path.join(pf, "VideoLAN", "VLC"))
    for d in dirs:
        for n in names:
            if os.path.isfile(os.path.join(d, n)):
                yield d, os.path.join(d, n)


def status(app_dir):
    """Charge libVLC une fois et indique si le lecteur embarqué est disponible."""
    global _STATUS, vlc
    if _STATUS is not None:
        return _STATUS
    where = ""
    for d, lib in _candidates(app_dir):
        os.environ["PYTHON_VLC_LIB_PATH"] = lib
        plugins = os.path.join(d, "plugins")
        if os.path.isdir(plugins):
            os.environ["PYTHON_VLC_MODULE_PATH"] = plugins
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(d)
            except OSError:
                pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        where = d
        break
    try:
        import vlc as _vlc  # python-vlc
        inst = _vlc.Instance("--quiet")
        ok = inst is not None
        ver = _vlc.libvlc_get_version().decode("utf-8", "replace") if ok else ""
        if inst:
            inst.release()
        vlc = _vlc if ok else None
        _STATUS = {"ok": ok, "where": where or ("VLC installé" if ok else ""), "version": ver, "error": ""}
    except Exception as e:  # noqa
        _STATUS = {"ok": False, "where": where, "version": "", "error": str(e)}
    return _STATUS


def clock(ms):
    s = max(0, int((ms or 0) / 1000))
    h, m, x = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{x:02d}" if h else f"{m}:{x:02d}"


# --------------------------------------------------------------------------- hôte (thread Tk)
class VlcHost:
    """Fait tourner Tk dans son propre thread ; les autres threads lui envoient des ordres."""

    def __init__(self, hooks):
        self.hooks = hooks
        self.q = queue.Queue()
        self.thread = None
        self.win = None
        self.inst = None

    def _ensure(self):
        if self.thread and self.thread.is_alive():
            return
        ready = threading.Event()
        self.thread = threading.Thread(target=self._run, args=(ready,), daemon=True, name="vlc-tk")
        self.thread.start()
        ready.wait(10)

    def play(self, payload):
        self._ensure()
        self.q.put(("play", payload))

    def stop(self):
        if self.thread and self.thread.is_alive():
            self.q.put(("stop", None))

    def is_open(self):
        return self.win is not None

    def _run(self, ready):
        import tkinter as tk
        self.tk = tk
        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except Exception:
                pass
        self.root = tk.Tk()
        self.root.withdraw()
        args = ["--quiet", "--no-video-title-show", "--sub-source=marq", "--no-snapshot-preview",
                "--avcodec-hw=any", "--sub-language=fr,fre,fra,french", "--audio-language=fr,fre,fra,french"]
        self.inst = vlc.Instance(*args)
        ready.set()
        self.root.after(40, self._poll)
        self.root.mainloop()

    def _poll(self):
        try:
            while True:
                cmd, arg = self.q.get_nowait()
                if cmd == "play":
                    if self.win:
                        self.win.replace(arg)
                    else:
                        try:
                            self.win = PlayerWindow(self, arg)
                        except Exception as e:  # noqa
                            self.win = None
                            self.hooks["event"]("Lecteur VLC : " + (str(e) or e.__class__.__name__), "error")
                            self.hooks["closed"](None)
                elif cmd == "stop" and self.win:
                    self.win.close()
        except queue.Empty:
            pass
        self.root.after(40, self._poll)


# --------------------------------------------------------------------------- petits widgets
HOVER = "#2a1d25"


def _draw_icon(c, name, s, col, o):
    """Icônes vectorielles dessinées sur un Canvas (mêmes pictogrammes que l'interface web)."""
    P = lambda *pts: [o + v * s for v in pts]          # noqa: E731  coordonnées relatives (0..1)
    w = max(2, s / 13)
    L = dict(fill=col, width=w, capstyle="round", joinstyle="round")
    if name == "play":
        c.create_polygon(*P(.3, .2, .3, .8, .8, .5), fill=col, outline=col, width=w, joinstyle="round")
    elif name == "pause":
        c.create_rectangle(*P(.27, .2, .41, .8), fill=col, outline="")
        c.create_rectangle(*P(.59, .2, .73, .8), fill=col, outline="")
    elif name == "back":
        c.create_line(*P(.78, .5, .24, .5), **L)
        c.create_line(*P(.46, .27, .23, .5, .46, .73), **L)
    elif name in ("rew", "fwd"):
        if name == "rew":
            c.create_arc(*P(.14, .14, .86, .86), start=100, extent=-300, style="arc", outline=col, width=w)
            c.create_line(*P(.52, .03, .42, .14, .52, .25), **L)
            txt = "10"
        else:
            c.create_arc(*P(.14, .14, .86, .86), start=80, extent=300, style="arc", outline=col, width=w)
            c.create_line(*P(.48, .03, .58, .14, .48, .25), **L)
            txt = "30"
        c.create_text(o + s * .5, o + s * .55, text=txt, fill=col, font=(FONT, max(7, int(s * .25)), "bold"))
    elif name in ("vol", "mute"):
        c.create_polygon(*P(.14, .38, .3, .38, .5, .2, .5, .8, .3, .62, .14, .62), fill=col, outline="")
        if name == "vol":
            c.create_arc(*P(.4, .3, .7, .7), start=-55, extent=110, style="arc", outline=col, width=w)
            c.create_arc(*P(.4, .16, .88, .84), start=-55, extent=110, style="arc", outline=col, width=w)
        else:
            c.create_line(*P(.62, .38, .86, .62), **L)
            c.create_line(*P(.86, .38, .62, .62), **L)
    elif name in ("fs", "fs_exit"):
        a, b = (.16, .36) if name == "fs" else (.36, .16)
        for sx, sy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            x0 = .16 if sx == 0 else .84
            y0 = .16 if sy == 0 else .84
            dx = .2 if sx == 0 else -.2
            dy = .2 if sy == 0 else -.2
            if name == "fs":
                c.create_line(*P(x0, y0 + dy, x0, y0, x0 + dx, y0), **L)
            else:
                cx, cy = x0 + dx, y0 + dy
                c.create_line(*P(x0, cy, cx, cy, cx, y0), **L)
    elif name == "sub":
        c.create_rectangle(*P(.12, .22, .88, .78), outline=col, width=w)
        c.create_line(*P(.26, .5, .44, .5), **L)
        c.create_line(*P(.54, .5, .74, .5), **L)
        c.create_line(*P(.26, .64, .6, .64), **L)
    elif name == "audio":
        c.create_arc(*P(.18, .18, .82, .82), start=0, extent=180, style="arc", outline=col, width=w)
        c.create_line(*P(.18, .5, .18, .62), **L)
        c.create_line(*P(.82, .5, .82, .62), **L)
        c.create_rectangle(*P(.14, .52, .3, .8), fill=col, outline="")
        c.create_rectangle(*P(.7, .52, .86, .8), fill=col, outline="")
    elif name == "src":
        c.create_rectangle(*P(.3, .16, .86, .58), outline=col, width=w)
        c.create_rectangle(*P(.14, .38, .7, .82), fill=BAR, outline=col, width=w)
    elif name == "next":
        c.create_polygon(*P(.2, .2, .2, .8, .64, .5), fill=col, outline="")
        c.create_rectangle(*P(.68, .2, .8, .8), fill=col, outline="")
    elif name == "chevL":
        c.create_line(*P(.62, .22, .34, .5, .62, .78), **L)
    elif name == "chevR":
        c.create_line(*P(.38, .22, .66, .5, .38, .78), **L)


class IconBtn:
    """Bouton rond à icône, avec texte facultatif, comme dans le lecteur de l'application."""

    def __init__(self, parent, icon, cmd, size=40, text="", fg=FG, tip=""):
        tk = parent.tk_mod
        self.icon, self.size, self.txt, self.fg, self.hover = icon, size, text, fg, False
        self.tip = tip
        width = size + (int(len(text) * size * .2) + 16 if text else 0)
        self.w = tk.Canvas(parent, width=width, height=size, bg=parent["bg"], highlightthickness=0, cursor="hand2")
        self.cmd = cmd
        self.w.bind("<Button-1>", lambda e: cmd())
        self.w.bind("<Enter>", lambda e: self._hov(True))
        self.w.bind("<Leave>", lambda e: self._hov(False))
        self.draw()

    def _hov(self, on):
        self.hover = on
        self.draw()
        bar = getattr(self.w.master, "hint_cb", None)
        if bar:
            bar(self.tip if on else "")

    def draw(self):
        c, s = self.w, self.size
        c.delete("all")
        W = int(c["width"])
        if self.hover:
            r = s / 2
            if self.txt:
                c.create_oval(2, 2, s - 2, s - 2, fill=HOVER, outline="")
                c.create_oval(W - s + 2, 2, W - 2, s - 2, fill=HOVER, outline="")
                c.create_rectangle(r, 2, W - r, s - 2, fill=HOVER, outline="")
            else:
                c.create_oval(2, 2, s - 2, s - 2, fill=HOVER, outline="")
        ic = int(s * (.66 if self.icon in ("rew", "fwd") else .55))
        _draw_icon(c, self.icon, ic, self.fg, (s - ic) / 2)
        if self.txt:
            c.create_text(s - 4, s / 2, text=self.txt, anchor="w", fill=self.fg, font=(FONT, max(9, int(s * .27)), "bold"))

    def set(self, icon=None, text=None):
        if icon:
            self.icon = icon
        if text is not None:
            self.txt = text
        self.draw()

    def pack(self, **kw):
        self.w.pack(**kw)
        return self


def _frame(tk, parent, **kw):
    f = tk.Frame(parent, **kw)
    f.tk_mod = tk
    return f


# --------------------------------------------------------------------------- fenêtre de lecture
class PlayerWindow:
    def __init__(self, host, payload):
        self.host, self.tk = host, host.tk
        tk = self.tk
        self.top = tk.Toplevel(host.root)
        self.top.configure(bg=BG)
        self.top.minsize(640, 400)
        self.top.title("ShippoTV")
        self.top.protocol("WM_DELETE_WINDOW", self.close)
        ic = payload.get("icon")
        if ic and os.path.isfile(ic):
            try:
                self._icon = tk.PhotoImage(file=ic)
                self.top.iconphoto(True, self._icon)
            except Exception:
                pass
        self.fs = False
        self.live = payload.get("kind") == "live"
        self.cur = payload
        self.idx = 0
        self.retries, self.retry_at, self.last_pos = 0, 0, 0
        self.played_once = self.retry_pending = self.gave_up = False
        self.idle_job = None
        self.last_save = 0
        self.closed = False
        self._build()
        self._dark_titlebar()
        self._place(payload)
        self.mp = host.inst.media_player_new()
        self.top.update_idletasks()
        wid = self.video.winfo_id()
        if sys.platform == "win32":
            self.mp.set_hwnd(wid)
        elif sys.platform == "darwin":
            self.mp.set_nsobject(wid)
        else:
            self.mp.set_xwindow(wid)
        self.mp.video_set_mouse_input(False)
        self.mp.video_set_key_input(False)
        v0 = int(host.hooks["volume"]() or 100)
        self.mp.audio_set_volume(v0)
        self.vol_v = v0
        self._draw_vol()
        self.start(payload)
        self._tick()
        if payload.get("fullscreen"):
            self.top.after(150, lambda: self.set_fs(True))
        self.top.focus_force()
        # la fenêtre principale s'efface une fois le lecteur affiché à sa place
        self.top.after(450, lambda: host.hooks.get("shown", lambda: None)())

    # ---------------------------------------------------------- construction
    def _build(self):
        tk = self.tk
        t = self.top
        self.topbar = _frame(tk, t, bg=BAR, height=56)
        self.topbar.pack(side="top", fill="x")
        self.b_back = IconBtn(self.topbar, "back", self.close, size=44, text="Retour", tip="Retour (Échap)").pack(side="left", padx=(12, 6), pady=6)
        self.l_status = tk.Label(self.topbar, text="", bg=BAR, fg=ACC2, font=(FONT, 10, "bold"))
        self.l_status.pack(side="right", padx=18)

        self.bottom = _frame(tk, t, bg=BAR)
        self.bottom.pack(side="bottom", fill="x")
        prow = _frame(tk, self.bottom, bg=BAR)
        prow.pack(fill="x", padx=(20, 18), pady=(12, 0))
        self.l_left = tk.Label(prow, text="", bg=BAR, fg=FG, font=(FONT, 10, "bold"))
        self.l_left.pack(side="right", padx=(12, 0))
        self.bar = tk.Canvas(prow, height=22, bg=BAR, highlightthickness=0, cursor="hand2")
        self.bar.pack(side="left", fill="x", expand=True)
        self.bar.bind("<Configure>", lambda e: self._draw_bar())
        self.bar.bind("<Button-1>", self._seek_click)
        self.bar.bind("<B1-Motion>", self._seek_click)
        self.bar.bind("<Motion>", self._bar_hover)
        self.bar.bind("<Leave>", self._bar_leave)
        self.hover_x = None

        row = _frame(tk, self.bottom, bg=BAR)
        row.pack(fill="x", padx=12, pady=(2, 12))
        row.hint_cb = self._hint
        self.b_play = IconBtn(row, "pause", self.toggle, size=48, tip="Lecture / pause (Espace)").pack(side="left")
        self.b_rew = IconBtn(row, "rew", lambda: self.seek(-10000), size=44, tip="Reculer de 10 s (←)")
        self.b_fwd = IconBtn(row, "fwd", lambda: self.seek(30000), size=44, tip="Avancer de 30 s (→)")
        self.b_prev = IconBtn(row, "chevL", lambda: self.zap(-1), size=44, tip="Chaîne précédente (Page préc.)")
        self.b_next = IconBtn(row, "chevR", lambda: self.zap(1), size=44, tip="Chaîne suivante (Page suiv.)")
        self.b_mute = IconBtn(row, "vol", self.mute, size=44, tip="Couper le son (M)").pack(side="left", padx=(8, 0))
        self.row = row
        self.vol = tk.Canvas(row, width=110, height=22, bg=BAR, highlightthickness=0, cursor="hand2")
        self.vol.pack(side="left", padx=(0, 10))
        self.vol_v = 100
        self.vol.bind("<Configure>", lambda e: self._draw_vol())
        for ev in ("<Button-1>", "<B1-Motion>"):
            self.vol.bind(ev, lambda e: self.set_volume(int(125 * min(1, max(0, e.x / 110))), osd=False))
        self.l_time = tk.Label(row, text="", bg=BAR, fg=MUTED, font=(FONT, 10))
        self.l_time.pack(side="left", padx=6)
        right = _frame(tk, row, bg=BAR)
        right.pack(side="right")
        right.hint_cb = self._hint
        self.b_fs = IconBtn(right, "fs", self.toggle_fs, size=44, tip="Plein écran (F)")
        self.b_src = IconBtn(right, "src", lambda: self.menu("src"), size=44, tip="Source")
        self.b_sub = IconBtn(right, "sub", lambda: self.menu("sub"), size=44, tip="Sous-titres (S)")
        self.b_audio = IconBtn(right, "audio", lambda: self.menu("audio"), size=44, tip="Langue audio (A)")
        self.b_nextep = IconBtn(right, "next", self.next_item, size=44, text="Épisode suivant", tip="Épisode suivant (N)")
        self.right = right
        mid = _frame(tk, row, bg=BAR)
        mid.pack(side="left", fill="x", expand=True)
        self.l_title = tk.Label(mid, text="", bg=BAR, fg=FG, font=(FONT, 12, "bold"))
        self.l_title.pack(side="top")
        self.l_sub = tk.Label(mid, text="", bg=BAR, fg=MUTED, font=(FONT, 10))
        self.l_sub.pack(side="top")
        self.show = {"src": False, "sub": False, "audio": False, "next": False}
        self._layout_right()

        self.video = tk.Frame(t, bg="black", cursor="arrow")
        self.video.pack(side="top", fill="both", expand=True)

        for w in (t, self.video):
            w.bind("<Motion>", lambda e: self.wake())
        self.video.bind("<Button-1>", lambda e: self.toggle())
        self.video.bind("<Double-Button-1>", lambda e: self.toggle_fs())
        # mêmes raccourcis que le lecteur de l'application
        keys = {
            ("space", "k", "K", "Return", "KP_Enter"): lambda: self.toggle(),
            ("Left",): lambda: self.seek(-10000),
            ("Right",): lambda: self.seek(30000),
            ("Up",): lambda: self.set_volume(self.vol_v + 10),
            ("Down",): lambda: self.set_volume(self.vol_v - 10),
            ("m", "M"): lambda: self.mute(),
            ("f", "F", "F11"): lambda: self.toggle_fs(),
            ("Escape",): lambda: self.set_fs(False) if self.fs else self.close(),
            ("BackSpace", "BrowserBack"): lambda: self.close(),
            ("n", "N", "Next"): lambda: self.zap(1) if self.live else self.next_item(),
            ("p", "P", "Prior"): lambda: self.zap(-1),
            ("a", "A"): lambda: self.cycle("audio"),
            ("s", "S"): lambda: self.cycle("sub"),
        }
        for names, fn in keys.items():
            for n in names:
                try:
                    t.bind(f"<{n}>" if len(n) > 1 else n, lambda e, fn=fn: (fn(), self.wake()))
                except Exception:
                    pass

    def _hint(self, txt):
        if txt:
            self.status_hint = True
            self.l_status.config(text=txt, fg=MUTED)
        elif getattr(self, "status_hint", False):
            self.status_hint = False
            self.l_status.config(text=getattr(self, "status_txt", ""), fg=ACC2)

    def _layout_right(self):
        order = [(self.b_fs, True), (self.b_src, self.show["src"]), (self.b_sub, self.show["sub"]),
                 (self.b_audio, self.show["audio"]), (self.b_nextep, self.show["next"])]
        for b, _ in order:
            b.w.pack_forget()
        for b, on in order:
            if on:
                b.w.pack(side="right")

    def _dark_titlebar(self):
        if sys.platform != "win32":
            return
        try:
            import ctypes
            self.top.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.top.winfo_id())
            val = ctypes.c_int(1)
            for attr in (20, 19):
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(val), ctypes.sizeof(val)) == 0:
                    break
        except Exception:
            pass

    def _place(self, p):
        g = p.get("geometry")
        sw, sh = self.top.winfo_screenwidth(), self.top.winfo_screenheight()
        if g and g.get("w", 0) > 300:
            self.top.geometry(f"{int(g['w'])}x{int(g['h'])}+{int(g['x'])}+{int(g['y'])}")
        else:
            w, h = int(sw * 0.8), int(sh * 0.8)
            self.top.geometry(f"{w}x{h}+{(sw - w) // 2}+{(sh - h) // 2}")

    # ---------------------------------------------------------- contenu
    def start(self, p, start_idx=None):
        self.p = p
        self.live = p.get("kind") == "live"
        self.items = [p] + list(p.get("queue") or [])
        self.item_i = 0
        self._show_item(p, start_idx or 0, resume=p.get("resume") or 0)

    def replace(self, p):
        self.save_progress(final=True)
        self.mp.stop()
        self.start(p)
        self.top.deiconify()
        self.top.lift()
        self.top.focus_force()

    def _show_item(self, item, idx=0, resume=0):
        self.cur = item
        self.top.title("ShippoTV")
        self.l_title.config(text=item.get("title", ""))
        self.l_sub.config(text=item.get("sub", "") or "")
        for b in (self.b_rew, self.b_fwd):
            b.w.pack_forget()
        for b in (self.b_prev, self.b_next):
            b.w.pack_forget()
        if self.live:
            self.b_prev.w.pack(side="left", after=self.b_play.w)
            self.b_next.w.pack(side="left", after=self.b_prev.w)
        else:
            self.b_rew.w.pack(side="left", after=self.b_play.w, padx=(4, 0))
            self.b_fwd.w.pack(side="left", after=self.b_rew.w)
        self.show.update(src=len(item["streams"]) > 1, next=self.item_i + 1 < len(self.items), sub=False, audio=False)
        self._layout_right()
        self.played_once, self.last_pos, self.retries = False, 0, 0
        self.load(0 if idx is None else idx, start_at=resume)
        if resume:
            self.top.after(1500, lambda: self.osd(f"Reprise à {clock(resume * 1000)}  ·  touche ← pour reculer", 4000))

    def load(self, idx, start_at=0):
        if idx != self.idx or not self.played_once:
            self.retries = 0
        self.retry_pending = self.gave_up = False
        self.idx = idx
        s = self.cur["streams"][idx]
        m = self.host.inst.media_new(s["url"])
        ua = self.host.hooks["ua"]()
        m.add_option(f":http-user-agent={ua}")
        m.add_option(":http-reconnect")
        m.add_option(":network-caching=" + ("2500" if self.live else "1500"))
        if start_at:
            m.add_option(f":start-time={int(start_at)}")
        self.mp.set_media(m)
        self.mp.play()
        self.t_load = time.time()
        self.played = False
        self.tracks_done = False
        self.status("Chargement…" if idx == 0 else f"{s.get('label') or 'Source ' + str(idx + 1)}…")

    def fail_source(self):
        """Coupure : on relance d'abord la MÊME source à la même position (3 fois) ; un film déjà commencé
        ne change jamais de version tout seul (sinon la qualité varie en plein film)."""
        if self.retry_pending or self.gave_up:
            return
        n = len(self.cur["streams"])
        pos = (self.last_pos or 0) / 1000 if not self.live else 0
        if self.played_once and self.retries < 3:
            self.retries += 1
            self.retry_at = pos
            self.retry_pending = True
            self.status("Coupure du flux, reprise…")
            idx = self.idx
            self.top.after(700 * self.retries, lambda: self.closed or self.load(idx, start_at=max(0, pos - 2)))
            return
        if self.played_once and not self.live:
            self.gave_up = True
            others = n > 1
            self.status("La lecture s'est interrompue : réessayez" + (" ou choisissez une autre version (menu Source)" if others else ""))
            self.host.hooks["event"]("Lecture interrompue : le serveur ne répond plus pour cette version", "error")
            return
        if self.idx + 1 < n:
            nxt = self.cur["streams"][self.idx + 1]
            self.status(f"Source indisponible, essai : {nxt.get('label') or 'source suivante'}")
            self.load(self.idx + 1, start_at=(self.mp.get_time() or 0) / 1000 if not self.live and self.played else 0)
        else:
            self.status("Aucune source ne répond pour le moment")
            self.host.hooks["event"]("Lecture impossible : aucune source ne répond", "error")

    # ---------------------------------------------------------- boucle d'état
    def _tick(self):
        if self.closed:
            return
        try:
            st = self.mp.get_state()
            S = vlc.State
            if st == S.Playing:
                t = self.mp.get_time() or 0
                if t > 0:
                    self.last_pos = t
                if self.retries and t / 1000 - self.retry_at > 90:
                    self.retries = 0
                if not self.played:
                    if not self.played_once:
                        self.top.after(2500, self._show_res)
                    self.played = True
                    self.played_once = True
                    self.status("")
                    self.top.after(1200, self._init_tracks)
                if self.b_play.icon != "pause":
                    self.b_play.set("pause")
            elif st == S.Paused:
                if self.b_play.icon != "play":
                    self.b_play.set("play")
            elif st == S.Error:
                self.fail_source()
            elif st == S.Ended:
                self.on_end()
            elif st in (S.Opening, S.Buffering, S.NothingSpecial) and not self.played and time.time() - self.t_load > 20:
                self.fail_source()
            self._update_time()
            if not self.live and self.played and time.time() - self.last_save > 10:
                self.save_progress()
        except Exception:
            pass
        self.top.after(250, self._tick)

    def _show_res(self):
        """Résolution réellement reçue (le nom du fichier peut annoncer autre chose)."""
        if self.closed:
            return
        try:
            w, h = self.mp.video_get_size(0)
        except Exception:
            return
        if not w or not h:
            return
        p = min(w * 9 / 16, h)
        res = "4K" if w >= 3200 or p >= 1800 else "1080p" if p >= 1000 else "720p" if p >= 700 else f"{int(p)}p"
        self.osd(f"Qualité reçue : {res}  ({w}×{h})", 3500)

    def on_end(self):
        if self.live:
            # un direct qui « se termine » = coupure : on relance la source, puis la suivante
            if time.time() - self.t_load > 30:
                self.load(self.idx)
            else:
                self.fail_source()
            return
        ln = self.mp.get_length() or 0
        if ln > 60000 and (self.last_pos or 0) < ln * 0.9:
            # film « terminé » bien avant la fin = coupure réseau : on reprend où on en était
            return self.fail_source()
        self.save_progress(final=True, done=True)
        if self.item_i + 1 < len(self.items):
            self.next_item()
        else:
            self.close()

    def _update_time(self):
        if self.live:
            n = self.cur.get("now") or {}
            if n.get("s"):
                self.l_time.config(text=f"{time.strftime('%H:%M', time.localtime(n['s']))} – "
                                        f"{time.strftime('%H:%M', time.localtime(n['e']))}")
            else:
                self.l_time.config(text="")
            self.l_left.config(text="●  DIRECT", fg=ACC)
        else:
            t, ln = self.mp.get_time(), self.mp.get_length()
            self.l_time.config(text=f"{clock(t)}  /  {clock(ln)}" if ln > 0 else "")
            self.l_left.config(text=("-" + clock(ln - t)) if ln > 0 else "", fg=FG)
        self._draw_bar()

    def _draw_bar(self):
        c = self.bar
        c.delete("all")
        w, h = c.winfo_width(), c.winfo_height()
        y = h // 2
        if self.live:
            n = self.cur.get("now") or {}
            frac = min(1, max(0, (time.time() - n["s"]) / max(1, n["e"] - n["s"]))) if n.get("s") else 1
        else:
            ln = self.mp.get_length() if hasattr(self, "mp") else 0
            frac = (self.mp.get_time() / ln) if ln and ln > 0 else 0
        x = max(2, int(w * min(1, max(0, frac))))
        hx = self.hover_x
        thick = 6 if hx is not None and not self.live else 4
        c.create_line(0, y, w, y, fill="#3a3946", width=thick, capstyle="round")
        c.create_line(0, y, x, y, fill=ACC, width=thick, capstyle="round")
        if not self.live:
            r = 8 if hx is not None else 6
            c.create_oval(x - r, y - r, x + r, y + r, fill=ACC, outline="")
            ln = self.mp.get_length() if hasattr(self, "mp") else 0
            if hx is not None and ln > 0:
                c.create_line(hx, y - 7, hx, y + 7, fill=FG, width=2)
                self._hint(clock(ln * min(1, max(0, hx / max(1, w)))))

    def _draw_vol(self):
        c = self.vol
        c.delete("all")
        w, y = 110, 11
        x = int(w * self.vol_v / 125)
        c.create_line(4, y, w - 4, y, fill="#3a3946", width=4, capstyle="round")
        c.create_line(4, y, max(4, x - 4), y, fill=ACC, width=4, capstyle="round")
        c.create_oval(max(0, x - 6), y - 6, max(12, x + 6) if x < 6 else x + 6, y + 6, fill=FG, outline="")

    def _bar_leave(self, e):
        self.hover_x = None
        self._hint("")
        self._draw_bar()

    def _bar_hover(self, e):
        self.hover_x = e.x
        self._draw_bar()
        self.wake()

    def _seek_click(self, e):
        if self.live:
            return
        ln = self.mp.get_length()
        if ln > 0:
            self.mp.set_time(int(ln * min(1, max(0, e.x / max(1, self.bar.winfo_width())))))
            self._draw_bar()

    # ---------------------------------------------------------- actions
    def status(self, txt):
        self.status_txt = txt
        self.l_status.config(text=txt, fg=ACC2)

    def osd(self, msg, ms=2000):
        try:
            O = vlc.VideoMarqueeOption
            self.mp.video_set_marquee_int(O.Enable, 1)
            self.mp.video_set_marquee_int(O.Size, 28)
            self.mp.video_set_marquee_int(O.Color, 0xFFFFFF)
            self.mp.video_set_marquee_int(O.Position, 5)   # en haut à gauche
            self.mp.video_set_marquee_int(O.X, 30)
            self.mp.video_set_marquee_int(O.Y, 24)
            self.mp.video_set_marquee_int(O.Timeout, ms)
            self.mp.video_set_marquee_string(O.Text, msg)
        except Exception:
            pass

    def toggle(self):
        if self.mp.get_state() == vlc.State.Ended:
            self.load(self.idx)
        else:
            self.mp.pause()
        self.wake()

    def seek(self, ms):
        if self.live:
            return
        t = max(0, self.mp.get_time() + ms)
        ln = self.mp.get_length()
        if ln > 0:
            t = min(t, ln - 2000)
        self.mp.set_time(int(t))
        self.osd(("» " if ms > 0 else "« ") + clock(t), 900)

    def set_volume(self, v, osd=True):
        v = max(0, min(125, int(v)))
        self.mp.audio_set_mute(False)
        self.mp.audio_set_volume(v)
        self.vol_v = v
        self._draw_vol()
        self.host.hooks["set_volume"](v)
        if osd:
            self.osd(f"Volume {v} %", 900)

    def mute(self):
        m = not self.mp.audio_get_mute()
        self.mp.audio_set_mute(m)
        self.b_mute.set("mute" if m else "vol")
        self.osd("Son coupé" if m else "Son rétabli", 900)

    def zap(self, d):
        if not self.live:
            return
        nxt = self.host.hooks["zap"](self.cur.get("key"), d)
        if nxt:
            self.mp.stop()
            self.items = [nxt]
            self.item_i = 0
            self._show_item(nxt)

    def next_item(self):
        if self.item_i + 1 >= len(self.items):
            return
        self.save_progress(final=True)
        self.item_i += 1
        it = self.items[self.item_i]
        self.mp.stop()
        self._show_item(it, 0, resume=it.get("resume") or 0)
        self.osd(it.get("sub") or it.get("title", ""), 3000)

    # pistes audio / sous-titres / sources
    def _tracks(self, kind):
        try:
            desc = self.mp.audio_get_track_description() if kind == "audio" else self.mp.video_get_spu_description()
            cur = self.mp.audio_get_track() if kind == "audio" else self.mp.video_get_spu()
        except Exception:
            return [], -1
        out = []
        for tid, name in desc or []:
            name = name.decode("utf-8", "replace") if isinstance(name, bytes) else str(name)
            if kind == "audio" and tid == -1:
                continue
            out.append((tid, "Désactivés" if tid == -1 else name))
        return out, cur

    def _init_tracks(self):
        if self.tracks_done or self.closed:
            return
        self.tracks_done = True
        a, _ = self._tracks("audio")
        s, _ = self._tracks("sub")
        self.show.update(sub=len(s) > 1, audio=len(a) > 1)
        self._layout_right()

    def cycle(self, kind):
        tr, cur = self._tracks(kind)
        if len(tr) < 2:
            return
        ids = [t[0] for t in tr]
        nxt = tr[(ids.index(cur) + 1) % len(tr)] if cur in ids else tr[0]
        (self.mp.audio_set_track if kind == "audio" else self.mp.video_set_spu)(nxt[0])
        self.osd(("Audio : " if kind == "audio" else "Sous-titres : ") + nxt[1], 1500)

    def menu(self, kind):
        tk = self.tk
        m = tk.Menu(self.top, tearoff=0, bg="#1b1a23", fg=FG, activebackground=ACC, activeforeground="#111",
                    font=(FONT, 11), bd=0, relief="flat", activeborderwidth=6)
        title = {"src": "Source", "sub": "Sous-titres", "audio": "Langue audio"}[kind]
        m.add_command(label=title, state="disabled")
        if kind == "src":
            for i, s in enumerate(self.cur["streams"]):
                lbl = ("● " if i == self.idx else "    ") + (s.get("label") or f"Source {i + 1}")
                m.add_command(label=lbl, command=lambda i=i: self.load(
                    i, start_at=(self.mp.get_time() or 0) / 1000 if not self.live else 0))
        else:
            tr, cur = self._tracks(kind)
            if not tr:
                m.add_command(label="Aucune piste", state="disabled")
            for tid, name in tr:
                m.add_command(label=("● " if tid == cur else "    ") + name,
                              command=lambda tid=tid: (self.mp.audio_set_track if kind == "audio" else self.mp.video_set_spu)(tid))
        btn = {"src": self.b_src, "sub": self.b_sub, "audio": self.b_audio}[kind].w
        m.tk_popup(btn.winfo_rootx(), btn.winfo_rooty() - 10 - 26 * max(1, m.index("end") + 1))

    # plein écran et masquage des commandes
    def toggle_fs(self):
        self.set_fs(not self.fs)

    def set_fs(self, on):
        self.fs = on
        self.top.attributes("-fullscreen", on)
        self.b_fs.set("fs_exit" if on else "fs")
        self.wake()

    def wake(self):
        if not self.topbar.winfo_ismapped():
            self.video.pack_forget()
            self.topbar.pack(side="top", fill="x")
            self.bottom.pack(side="bottom", fill="x")
            self.video.pack(side="top", fill="both", expand=True)
        self.video.config(cursor="arrow")
        if self.idle_job:
            self.top.after_cancel(self.idle_job)
        self.idle_job = self.top.after(3000, self._hide)

    def _hide(self):
        self.idle_job = None
        if self.fs and self.mp.is_playing():
            self.topbar.pack_forget()
            self.bottom.pack_forget()
            self.video.config(cursor="none")

    # ---------------------------------------------------------- progression et fermeture
    def save_progress(self, final=False, done=False):
        it = getattr(self, "cur", None)
        if not it or self.live or not it.get("pid"):
            return
        pos, dur = (self.mp.get_time() or 0) / 1000, (self.mp.get_length() or 0) / 1000
        if dur <= 0 or (pos < 5 and not final):
            return
        self.last_save = time.time()
        done = done or pos / dur > 0.94
        self.host.hooks["progress"]({
            "id": it["pid"], "kind": it.get("kind") or self.p.get("kind"), "key": it.get("key") or self.p.get("key"),
            "label": it.get("sub"), "ep": it.get("ep"), "pos": pos, "dur": dur,
            "vid": it["streams"][self.idx].get("id"), "clear": done,
            "profile": it.get("profile") or self.p.get("profile"),
        })

    def close(self):
        if self.closed:
            return
        self.save_progress(final=True)
        self.closed = True
        geo = None
        try:
            if not self.fs:
                self.top.update_idletasks()
                geo = {"x": self.top.winfo_x(), "y": self.top.winfo_y(),
                       "w": self.top.winfo_width(), "h": self.top.winfo_height()}
        except Exception:
            pass
        try:
            self.mp.stop()
            self.mp.release()
        except Exception:
            pass
        try:
            self.top.destroy()
        except Exception:
            pass
        self.host.win = None
        self.host.hooks["closed"](geo)

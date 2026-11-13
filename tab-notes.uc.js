// ==UserScript==
// @name            Zolf Mods Tab Notes
// @description     Notes for tabs and folders: context menu entry, indicator and a rich-text note window.
// @include         main
// ==/UserScript==

(() => {
  "use strict";

  if (window.__zolfModsTabNotesLoaded) return;
  window.__zolfModsTabNotesLoaded = true;

  const ROOT = "mod.zolfmods.tab-notes.";
  const LOG = "[ZolfModsTabNotes]";

  // ---------------------------------------------------------------------
  // Where notes live
  //  - tabs:    in the tab's session data (SessionStore custom value, so a note comes
  //             back with "Restore closed tab") AND in the notes file;
  //  - folders: in the notes file only.
  // The notes file is <profile>/zolfmods-tab-notes.json, keyed by the tab id
  // ("folder:<id>" for folders) - it is what survives restarts for pinned tabs,
  // Essentials and folders, which Zen rebuilds on its own.
  //
  // A note is a tiny subset of HTML (b, i, u, s, br). It is never inserted with
  // innerHTML: it is parsed, whitelisted and rebuilt node by node.
  // ---------------------------------------------------------------------
  const TabNotes = (() => {
    const PREF_INDICATOR = ROOT + "indicator";
    const KEY = "ztn-note";
    const LEGACY_KEY = "rzt-note"; // saved by the old RandomZenTweaks mod
    const HTML_PREFIX = "rzt:html:"; // unchanged on purpose: keeps older notes readable
    const XHTML = "http://www.w3.org/1999/xhtml";
    const STORE_FILE = PathUtils.join(PathUtils.profileDir, "zolfmods-tab-notes.json");
    const LEGACY_STORE_FILE = PathUtils.join(PathUtils.profileDir, "randomzentweaks-notes.json");
    const Z_BASE = 2147483000;
    const SS =
      typeof SessionStore !== "undefined"
        ? SessionStore
        : ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs").SessionStore;

    const FORMAT_TAGS = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s" };
    const FORMAT_BUTTONS = [
      ["bold", "B", "Bold"],
      ["italic", "I", "Italic"],
      ["underline", "U", "Underline"],
      ["strikeThrough", "S", "Strikethrough"],
    ];

    const windows = new Set(); // every visible note window
    let transient = null; // the hover / edit window that is not detached yet
    let zTop = Z_BASE;
    let scrim = null;
    let shield = null;
    let showTimer = 0;
    let hideTimer = 0;
    let scrimTimer = 0;
    let folderTimer = 0;
    let overIndicator = false;
    let lastPointerTarget = null;
    let sidebarHeld = false;
    let weSetHover = false; // we added zen-has-hover ourselves and must take it back
    let lastPeekHover = 0; // last time the pointer was on a peeking note or its indicator
    const menuItems = {};

    let store = {}; // key -> { t: stored value, u: updated }
    let flushTimer = 0;

    const h = (tag, cls, text) => {
      const el = document.createElementNS(XHTML, tag);
      if (cls) el.className = cls;
      if (text) el.textContent = text;
      return el;
    };

    // ---- subjects: a tab or a Zen folder ----
    const isFolder = (s) => s.localName === "zen-folder";
    const keyOf = (s) => (isFolder(s) ? (s.id ? "folder:" + s.id : "") : s.id || "");
    const labelOf = (s) => (isFolder(s) ? s.label || s.getAttribute("label") : s.label) || "";
    const folderFrom = (node) => (node && node.closest ? node.closest("zen-folder") : null);

    // ---- note format helpers ----
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const hasText = (html) => html.replace(/<[^>]*>/g, "").trim().length > 0;
    const rawToHtml = (raw) =>
      raw.startsWith(HTML_PREFIX) ? raw.slice(HTML_PREFIX.length) : esc(raw).replace(/\r?\n/g, "<br>");

    function serialize(root) {
      let out = "";
      const walk = (node) => {
        for (const n of node.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            out += esc(n.nodeValue);
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            const tag = n.localName.toUpperCase();
            if (tag === "BR") {
              out += "<br>";
            } else if (FORMAT_TAGS[tag]) {
              const t = FORMAT_TAGS[tag];
              out += "<" + t + ">";
              walk(n);
              out += "</" + t + ">";
            } else if (tag === "DIV" || tag === "P") {
              if (out && !out.endsWith("<br>")) out += "<br>";
              walk(n);
            } else {
              walk(n);
            }
          }
        }
      };
      walk(root);
      return out.replace(/(<br>)+$/, "");
    }

    function renderInto(target, html) {
      target.replaceChildren();
      const parsed = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
      const build = (src, dst) => {
        for (const n of src.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            dst.appendChild(document.createTextNode(n.nodeValue));
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            const tag = n.localName;
            if (tag === "br") {
              dst.appendChild(document.createElementNS(XHTML, "br"));
            } else if (tag === "b" || tag === "i" || tag === "u" || tag === "s") {
              const e = document.createElementNS(XHTML, tag);
              dst.appendChild(e);
              build(n, e);
            } else {
              build(n, dst);
            }
          }
        }
      };
      build(parsed.body, target);
    }

    // ---- storage ----
    async function loadStore() {
      let migrated = false;
      try {
        const data = await IOUtils.readJSON(STORE_FILE);
        if (data && typeof data.notes === "object" && data.notes) store = data.notes;
      } catch (e) {
        // no file yet: import the notes of the old RandomZenTweaks mod, if there are any
        try {
          const legacy = await IOUtils.readJSON(LEGACY_STORE_FILE);
          if (legacy && typeof legacy.notes === "object" && legacy.notes) {
            store = legacy.notes;
            migrated = true;
          }
        } catch (e2) {}
      }
      if (migrated) flushStore();
      refreshAll();
    }

    function flushStore() {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(async () => {
        try {
          await IOUtils.writeJSON(STORE_FILE, { version: 2, notes: store }, { tmpPath: STORE_FILE + ".tmp" });
        } catch (e) {
          console.error(LOG, "could not write notes file", e);
        }
      }, 400);
    }

    function pruneStore() {
      const open = new Set(Array.from(gBrowser.tabs, (t) => t.id).filter(Boolean));
      for (const f of document.querySelectorAll("zen-folder")) if (f.id) open.add("folder:" + f.id);
      const cutoff = Date.now() - 120 * 24 * 3600 * 1000;
      let changed = false;
      for (const [k, v] of Object.entries(store)) {
        if (!open.has(k) && (v.u || 0) < cutoff) {
          delete store[k];
          changed = true;
        }
      }
      if (changed) flushStore();
    }

    function getRaw(s) {
      let value = "";
      if (!isFolder(s)) {
        try {
          value = SS.getCustomTabValue(s, KEY) || SS.getCustomTabValue(s, LEGACY_KEY) || "";
        } catch (e) {}
      }
      if (!value) {
        const k = keyOf(s);
        if (k && store[k]) value = store[k].t || "";
      }
      return value;
    }

    const getHtml = (s) => {
      const raw = getRaw(s);
      return raw ? rawToHtml(raw) : "";
    };
    const hasNote = (s) => hasText(getHtml(s));

    function saveNote(s, html) {
      const has = hasText(html);
      const raw = HTML_PREFIX + html;
      if (!isFolder(s)) {
        try {
          if (has) SS.setCustomTabValue(s, KEY, raw);
          else SS.deleteCustomTabValue(s, KEY);
        } catch (e) {
          console.error(LOG, "could not save note to the session", e);
        }
      }
      const k = keyOf(s);
      if (k) {
        if (has) store[k] = { t: raw, u: Date.now() };
        else delete store[k];
        flushStore();
      }
      refresh(s);
    }

    // ---- indicator on a tab / folder ----
    const indicatorMode = () =>
      Services.prefs.getStringPref(PREF_INDICATOR, "") === "icon" ? "icon" : "ribbon";

    // Zen draws the folder icon on its own (it takes no room in the row) and keeps the folder name
    // clear of it with a left margin / padding on the name. A note icon put in front of the name
    // would therefore land ON the folder icon. So that "room" is moved in front of the note icon:
    // [folder icon][note icon][name].
    function placeBeforeFolderLabel(ind, label) {
      const startX = label.getBoundingClientRect().left;
      const cs = getComputedStyle(label);
      const lead = (parseFloat(cs.marginInlineStart) || 0) + (parseFloat(cs.paddingInlineStart) || 0);

      label.before(ind);
      ind._ztnLabel = label;

      if (lead > 0) {
        ind.style.marginInlineStart = lead + "px";
        label.style.setProperty("margin-inline-start", "0", "important");
        label.style.setProperty("padding-inline-start", "0", "important");
      }

      // measure: the note icon must start exactly where the name used to start
      if (startX > 0) {
        const delta = startX - ind.getBoundingClientRect().left;
        if (Math.abs(delta) > 1) {
          ind.style.marginInlineStart = (parseFloat(ind.style.marginInlineStart) || 0) + delta + "px";
        }
      }
    }

    function dropIndicator(s) {
      const ind = s._ztnIndicator;
      if (ind) {
        const label = ind._ztnLabel;
        if (label) {
          label.style.removeProperty("margin-inline-start");
          label.style.removeProperty("padding-inline-start");
        }
        ind.remove();
      }
      s._ztnIndicator = null;
    }

    function createIndicator(s, mode, essential) {
      const folder = isFolder(s);
      const container = folder
        ? s.querySelector(".tab-group-label-container") || s
        : s.querySelector(".tab-content");
      if (!container) return null;

      const ind = h(
        "div",
        "ztn-note-indicator " + (mode === "icon" ? "ztn-note-icon" : "ztn-note-ribbon") + (folder ? " ztn-note-folder" : "")
      );
      ind.addEventListener("mouseenter", () => {
        overIndicator = true; // keeps tooltips, previews and the folder search popup from showing
        hideHoverPopups();
        lastPeekHover = Date.now();
        scheduleShow(s);
      });
      ind.addEventListener("mouseleave", () => {
        overIndicator = false;
        scheduleHide(180);
      });
      ind.addEventListener("mousedown", (e) => e.stopPropagation());
      ind.addEventListener("click", (e) => {
        e.stopPropagation();
        openWindow(s, "edit", ind);
      });

      if (mode === "icon" && !essential) {
        // regular tabs: right next to the mute button; folders: right after the folder name
        ind.classList.add("ztn-note-inline");
        if (folder) {
          // left side, directly before the folder name - like next to the mute button on tabs
          const label = container.querySelector(".tab-group-label");
          if (label) placeBeforeFolderLabel(ind, label);
          else container.prepend(ind);
        } else {
          const ref = container.querySelector(".tab-audio-button") || container.querySelector(".tab-icon-stack");
          if (ref) ref.after(ind);
          else container.appendChild(ind);
        }
      } else {
        container.appendChild(ind);
      }
      return ind;
    }

    function refresh(s) {
      if (!s || s.closing) return;
      let ind = s._ztnIndicator;
      const raw = getRaw(s);

      if (!raw || !hasText(rawToHtml(raw))) {
        s.removeAttribute("ztn-note");
        dropIndicator(s);
        return;
      }

      s.setAttribute("ztn-note", "true");

      if (!isFolder(s)) {
        // keep the session copy in sync when the note came from the file
        try {
          if (!SS.getCustomTabValue(s, KEY)) SS.setCustomTabValue(s, KEY, raw);
        } catch (e) {}
      }

      const mode = indicatorMode();
      const essential = !isFolder(s) && s.hasAttribute("zen-essential");
      const kind = mode + (essential ? "-essential" : isFolder(s) ? "-folder" : "-regular");
      if (ind && ind.isConnected && ind.dataset.ztnKind === kind) return;

      dropIndicator(s);
      ind = createIndicator(s, mode, essential);
      if (!ind) return;
      ind.dataset.ztnKind = kind;
      s._ztnIndicator = ind;
    }

    function refreshFolders() {
      for (const f of document.querySelectorAll("zen-folder")) refresh(f);
    }

    function refreshAll() {
      for (const tab of gBrowser.tabs) refresh(tab);
      refreshFolders();
    }

    // ---- keeping Zen's compact sidebar open while a (not yet detached) note window is used ----
    // Zen's compact mode only looks at attributes on #navigator-toolbox: has-popup-menu keeps
    // the sidebar open, zen-has-hover is what the pointer normally sets.
    const toolbox = () => document.getElementById("navigator-toolbox");
    const compactMode = () => document.documentElement.getAttribute("zen-compact-mode") === "true";

    function holdSidebar() {
      const tb = toolbox();
      if (!tb) return;
      sidebarHeld = true;
      tb.setAttribute("has-popup-menu", "true");
    }

    // Gives the sidebar back to Zen. Nothing of ours may stay on the toolbox afterwards: a leftover
    // attribute (that Zen's own pointer logic does not know about) keeps the sidebar open for good.
    function releaseSidebar() {
      sidebarHeld = false;
      const tb = toolbox();
      if (!tb) return;
      try {
        if (tb.matches(":hover")) {
          // the pointer is on the sidebar: make sure it stays open, and take our flag back when it leaves
          if (!tb.hasAttribute("zen-has-hover")) {
            tb.setAttribute("zen-has-hover", "true");
            weSetHover = true;
            tb.addEventListener(
              "mouseleave",
              () => {
                setTimeout(() => {
                  if (weSetHover && !tb.matches(":hover")) tb.removeAttribute("zen-has-hover");
                  weSetHover = false;
                }, 300);
              },
              { once: true }
            );
          }
        } else {
          const keep = Services.prefs.getIntPref("zen.view.compact.sidebar-keep-hover.duration", 150);
          window.gZenCompactModeManager?.flashElement?.(tb, keep, "has-hover" + tb.id, "zen-has-hover");
        }
      } catch (e) {
        console.error(LOG, "could not hand the sidebar back", e);
      }
      tb.removeAttribute("has-popup-menu");
    }

    function updateHold() {
      const need = !!transient && compactMode();
      if (need && !sidebarHeld) holdSidebar();
      else if (!need && sidebarHeld) releaseSidebar();
    }

    // ---- layers: scrim (swallows the closing click) and shield (keeps a drag alive over the page) ----
    function ensureLayers() {
      if (scrim) return;

      scrim = h("div", "ztn-note-scrim");
      scrim.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (transient) closeWindow(transient, true);
      });
      for (const type of ["mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
        scrim.addEventListener(type, (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (type === "click" || type === "auxclick" || type === "contextmenu") releaseScrim();
        });
      }

      shield = h("div", "ztn-note-shield");

      document.documentElement.append(scrim, shield);
    }

    function activateScrim() {
      clearTimeout(scrimTimer);
      scrim?.setAttribute("active", "");
    }
    function releaseScrim() {
      clearTimeout(scrimTimer);
      scrim?.removeAttribute("active");
    }
    function releaseScrimSoon() {
      clearTimeout(scrimTimer);
      scrimTimer = setTimeout(releaseScrim, 350);
    }

    // ---- the note windows (rich text, auto-saving) ----
    function updateFormatButtons() {
      const active = document.activeElement;
      for (const w of windows) {
        const focused = !!active && w.text.contains(active);
        for (const [cmd] of FORMAT_BUTTONS) {
          let on = false;
          if (focused) {
            try {
              on = document.queryCommandState(cmd);
            } catch (e) {}
          }
          w.fmt[cmd].classList.toggle("active", on);
        }
      }
    }

    function scheduleSave(w) {
      clearTimeout(w.saveTimer);
      w.saveTimer = setTimeout(() => commit(w), 250);
    }

    function commit(w) {
      clearTimeout(w.saveTimer);
      const html = serialize(w.text);
      if (html === w.lastSaved) return;
      w.lastSaved = html;
      saveNote(w.subject, html);
    }

    function bringToFront(w) {
      zTop = Math.min(zTop + 1, 2147483640);
      w.el.style.zIndex = String(zTop);
    }

    function setMode(w, mode) {
      w.mode = mode;
      w.el.dataset.mode = mode;
      if (mode === "edit") activateScrim();
      updateHold();
    }

    function clampToViewport(w) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = w.el.getBoundingClientRect();
      const left = Math.min(Math.max(0, r.left), Math.max(0, vw - r.width));
      const top = Math.min(Math.max(0, r.top), Math.max(0, vh - 40));
      w.el.style.left = left + "px";
      w.el.style.top = top + "px";
    }

    // The window is placed ONCE when it opens (next to the indicator / tab), never again while
    // it is used: with an expand-on-hover sidebar the tab moves as soon as the sidebar collapses.
    function placeNear(w, anchor) {
      const r = anchor.getBoundingClientRect();
      const cw = w.el.offsetWidth || 300;
      const ch = w.el.offsetHeight || 120;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = r.right + 10;
      if (left + cw > vw - 8) left = Math.max(8, r.left - cw - 10);
      const top = Math.min(Math.max(8, r.top - 4), Math.max(8, vh - ch - 8));
      w.el.style.left = left + "px";
      w.el.style.top = top + "px";
    }

    function clampVertical(w) {
      const r = w.el.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom > vh - 8) w.el.style.top = Math.max(8, vh - 8 - r.height) + "px";
    }

    function focusEnd(w) {
      w.text.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(w.text);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // grabbing the title bar detaches the window: it stops following the sidebar logic,
    // gets a close button, and any number of such windows can stay on the screen
    function makeFloating(w) {
      if (w.mode === "float") return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (transient === w) transient = null;
      setMode(w, "float");
      releaseScrim();
      updateHold();
    }

    function startDrag(w, e) {
      e.preventDefault(); // keeps the focus (and the selection) where it was
      const r = w.el.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const dx = sx - r.left;
      const dy = sy - r.top;
      let moved = false;

      const onMove = (ev) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
          moved = true;
          makeFloating(w);
          bringToFront(w);
          shield.setAttribute("active", "");
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = Math.min(Math.max(0, ev.clientX - dx), Math.max(0, vw - w.el.offsetWidth));
        const top = Math.min(Math.max(0, ev.clientY - dy), Math.max(0, vh - 40));
        w.el.style.left = left + "px";
        w.el.style.top = top + "px";
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        shield.removeAttribute("active");
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    }

    function buildWindow(subject) {
      const w = { subject, mode: null, lastSaved: "", saveTimer: 0, openedAt: 0, fmt: {} };
      w.el = h("div", "ztn-note-card");

      const head = h("div", "ztn-note-head");
      w.title = h("span", "ztn-note-title");

      const bar = h("div", "ztn-note-fmt");
      bar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      for (const [cmd, glyph, title] of FORMAT_BUTTONS) {
        const b = h("button", "ztn-note-fmt-btn ztn-fmt-" + cmd, glyph);
        b.setAttribute("title", title);
        b.addEventListener("click", () => {
          w.text.focus();
          document.execCommand(cmd);
          updateFormatButtons();
          scheduleSave(w);
        });
        w.fmt[cmd] = b;
        bar.append(b);
      }

      const closeBtn = h("button", "ztn-note-close", "×");
      closeBtn.setAttribute("title", "Close");
      closeBtn.addEventListener("click", () => closeWindow(w, true));

      head.append(h("span", "ztn-note-label", "Note"), w.title, bar, closeBtn);
      head.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest(".ztn-note-fmt, .ztn-note-close")) return;
        startDrag(w, e);
      });

      w.text = h("div", "ztn-note-text");
      w.text.setAttribute("contenteditable", "true");
      w.text.setAttribute("spellcheck", "false");
      w.text.setAttribute("data-placeholder", "Write a note…");

      w.el.append(head, w.text);

      w.el.addEventListener("mouseenter", () => {
        lastPeekHover = Date.now();
        if (transient === w) clearTimeout(hideTimer);
      });
      w.el.addEventListener("mouseleave", () => {
        if (w.mode === "peek") scheduleHide(90);
      });
      w.el.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        bringToFront(w);
      });

      w.text.addEventListener("input", () => {
        if (w.text.textContent === "" && !w.text.querySelector("br:not(:only-child)")) {
          w.text.replaceChildren(); // lets the placeholder show again
        }
        clampVertical(w);
        scheduleSave(w);
        updateFormatButtons();
      });
      w.text.addEventListener("focus", () => {
        try {
          document.execCommand("styleWithCSS", false, false);
        } catch (e) {}
        if (w.mode === "peek") setMode(w, "edit");
      });
      w.text.addEventListener("blur", (e) => {
        if (w.mode !== "edit") return; // detached windows stay open
        if (e.relatedTarget && w.el.contains(e.relatedTarget)) return;
        if (Date.now() - w.openedAt < 500) {
          // the context menu was still closing and stole the focus back
          setTimeout(() => w.text.focus(), 0);
          return;
        }
        closeWindow(w, true);
      });
      w.text.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          closeWindow(w, true);
        } else if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          if (e.shiftKey) document.execCommand("insertLineBreak");
          else closeWindow(w, true); // Enter closes, Shift+Enter = new line
        }
      });
      for (const type of ["keyup", "keypress"]) {
        w.text.addEventListener(type, (e) => e.stopPropagation());
      }
      w.text.addEventListener("paste", (e) => {
        e.preventDefault(); // plain text only
        const text = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
        text.split("\n").forEach((line, i) => {
          if (i) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
      });
      w.text.addEventListener("drop", (e) => e.preventDefault());

      return w;
    }

    const findFloating = (subject) => {
      for (const w of windows) if (w.mode === "float" && w.subject === subject) return w;
      return null;
    };

    function openWindow(subject, mode, anchor) {
      if (!subject) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);

      const floating = findFloating(subject);
      if (floating) {
        bringToFront(floating);
        if (mode === "edit") floating.text.focus();
        return;
      }
      if (transient && transient.subject === subject) {
        if (mode === "edit" && transient.mode !== "edit") {
          setMode(transient, "edit");
          transient.text.focus();
        }
        return;
      }
      if (transient) closeWindow(transient, true);

      ensureLayers();
      const w = buildWindow(subject);
      windows.add(w);
      transient = w;
      document.documentElement.appendChild(w.el);

      renderInto(w.text, getHtml(subject));
      w.lastSaved = serialize(w.text);
      w.title.textContent = labelOf(subject);
      w.openedAt = Date.now();
      bringToFront(w);
      placeNear(w, anchor || subject);
      w.el.setAttribute("open", "");
      setMode(w, mode);
      updateFormatButtons();

      if (mode === "edit") focusEnd(w);
    }

    function closeWindow(w, save) {
      if (!windows.has(w)) return;
      clearTimeout(w.saveTimer);
      if (save) {
        try {
          commit(w);
        } catch (e) {
          console.error(LOG, "could not save the note", e);
        }
      }
      windows.delete(w);

      const wasEditing = w.mode === "edit";
      if (transient === w) {
        transient = null;
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
      }
      w.el.removeAttribute("open");
      if (document.activeElement === w.text) w.text.blur();
      w.mode = null;
      setTimeout(() => w.el.remove(), 220);

      if (wasEditing) releaseScrimSoon(); // keep swallowing the click that closed the window
      updateHold();
    }

    function closeWindowsOf(subject, save) {
      for (const w of [...windows]) if (w.subject === subject) closeWindow(w, save);
    }

    function scheduleShow(subject) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(() => openWindow(subject, "peek", subject._ztnIndicator), 140);
    }

    function scheduleHide(delay) {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (transient && transient.mode === "peek") closeWindow(transient, true);
      }, delay);
    }

    function deleteNote(subject) {
      closeWindowsOf(subject, false);
      saveNote(subject, "");
    }

    // ---- hover popups (tab tooltip / preview, Zen's folder search) ----
    // only the two context menus below may open while the pointer is on an indicator
    const ALLOWED_POPUPS = new Set(["tabContextMenu", "zenFolderActions"]);

    function hideHoverPopups() {
      try {
        document.getElementById("tab-preview-panel")?.hidePopup();
        for (const p of document.querySelectorAll("panel, menupopup")) {
          if (p.state === "open" && !ALLOWED_POPUPS.has(p.id) && p.id !== "tab-preview-panel") {
            if (p.closest?.("zen-folder") || /folder|search|preview/i.test(p.id || "")) p.hidePopup();
          }
        }
      } catch (e) {}
    }

    // ---- context menus: "Add Note..." / "Delete Note..." for tabs and folders ----
    function ensureMenuItem(kind, popup, anchorSelector) {
      let mi = menuItems[kind];
      if (!mi) {
        mi = document.createXULElement("menuitem");
        mi.id = "context_ztn-note-" + kind;
        mi.setAttribute("label", "Add Note...");
        mi.addEventListener("command", () => {
          const s = mi._ztnSubject;
          if (!s) return;
          if (hasNote(s)) deleteNote(s);
          else setTimeout(() => openWindow(s, "edit", s), 80);
        });
        menuItems[kind] = mi;
      }
      if (!mi.isConnected || mi.parentNode !== popup) {
        const anchor = anchorSelector ? popup.querySelector(anchorSelector) : null;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(mi, anchor);
        else popup.insertBefore(mi, popup.firstElementChild);
      }
      return mi;
    }

    // Runs ON the popup (target phase), i.e. after the browser's own onpopupshowing handler has
    // filled in TabContextMenu.contextTab - a document-level capture listener would see it too early.
    function updateMenu(popup) {
      let subject = null;
      let mi = null;
      if (popup.id === "tabContextMenu") {
        mi = ensureMenuItem(
          "tab",
          popup,
          '#context_zen-edit-tab-title, [data-l10n-id="tab-context-zen-edit-title"]'
        );
        subject =
          window.TabContextMenu?.contextTab ||
          (popup.triggerNode && popup.triggerNode.closest ? popup.triggerNode.closest("tab") : null);
      } else if (popup.id === "zenFolderActions") {
        mi = ensureMenuItem("folder", popup, '[data-l10n-id*="rename" i], [id*="rename" i]');
        subject =
          folderFrom(popup.triggerNode) || folderFrom(popup.anchorNode) || folderFrom(lastPointerTarget);
      }
      if (!mi) return;

      mi._ztnSubject = subject;
      mi.hidden = !subject;
      mi.setAttribute("label", subject && hasNote(subject) ? "Delete Note..." : "Add Note...");
    }

    function bindMenu(popup) {
      if (!popup || popup._ztnBound) return;
      popup._ztnBound = true;
      popup.addEventListener("popupshowing", (e) => {
        if (e.target === popup) updateMenu(popup);
      });
    }

    function onPopupShowing(e) {
      const popup = e.target;

      if (overIndicator && !ALLOWED_POPUPS.has(popup.id)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // popups that did not exist at start-up are bound the first time they show
      if (ALLOWED_POPUPS.has(popup.id)) bindMenu(popup);
    }

    // Safety net. Whatever happens (a missed mouseleave, a removed indicator, a lost focus, an
    // exception somewhere) a note window that is only being peeked at must close once the pointer
    // is gone, and the sidebar must never stay held without a window.
    function reconcile() {
      if (!transient && !sidebarHeld) return;
      try {
        if (transient && !transient.el.isConnected) closeWindow(transient, false);
        const t = transient;
        if (t && t.mode === "peek") {
          const ind = t.subject._ztnIndicator;
          const over = t.el.matches(":hover") || (!!ind && ind.isConnected && ind.matches(":hover"));
          if (over) lastPeekHover = Date.now();
          else if (Date.now() - lastPeekHover > 600) closeWindow(t, true);
        }
        updateHold();
      } catch (e) {
        console.error(LOG, "watchdog", e);
      }
    }

    // ---- start-up ----
    function onResize() {
      if (transient) placeNear(transient, transient.subject._ztnIndicator || transient.subject);
      for (const w of windows) if (w.mode === "float") clampToViewport(w);
    }

    function init() {
      document.addEventListener("popupshowing", onPopupShowing, true);
      for (const id of ALLOWED_POPUPS) bindMenu(document.getElementById(id));
      for (const type of ["mousedown", "contextmenu"]) {
        document.addEventListener(type, (e) => (lastPointerTarget = e.target), true);
      }
      document.addEventListener("selectionchange", updateFormatButtons);
      window.addEventListener("resize", onResize);

      const tabs = gBrowser.tabContainer;
      tabs.addEventListener("SSTabRestored", (e) => refresh(e.target));
      tabs.addEventListener("TabClose", (e) => closeWindowsOf(e.target, true));
      window.addEventListener("SSWindowStateReady", refreshAll);

      // a tab can become / stop being an Essential at any time
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.target?.localName === "tab") refresh(r.target);
        }
      }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["zen-essential"] });

      // folders are created / restored by Zen after start-up
      new MutationObserver(() => {
        clearTimeout(folderTimer);
        folderTimer = setTimeout(() => {
          refreshFolders();
          for (const w of [...windows]) if (!w.subject.isConnected) closeWindow(w, true);
        }, 300);
      }).observe(tabs, { subtree: true, childList: true });

      // Zen may clear has-popup-menu when another popup closes: put it back while we hold the sidebar
      const tb = toolbox();
      if (tb) {
        new MutationObserver(() => {
          if (sidebarHeld && transient && !tb.hasAttribute("has-popup-menu")) tb.setAttribute("has-popup-menu", "true");
        }).observe(tb, { attributes: true, attributeFilter: ["has-popup-menu"] });
      }

      loadStore();
      // session data can arrive a little after startup
      setTimeout(refreshAll, 2000);
      setTimeout(refreshAll, 6000);
      setTimeout(pruneStore, 15000);
      setInterval(reconcile, 500);
    }

    return { init, refreshAll };
  })();

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function init() {
    Services.prefs.addObserver(ROOT + "indicator", {
      observe() {
        TabNotes.refreshAll();
      },
    });
    TabNotes.init();
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const obs = {
      observe(subject, topic) {
        if (topic === "browser-delayed-startup-finished" && subject === window) {
          Services.obs.removeObserver(obs, topic);
          init();
        }
      },
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();

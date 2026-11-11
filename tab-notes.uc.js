// ==UserScript==
// @name            Zolf Mods Tab Notes
// @description     Notes for tabs: context menu entry, tab indicator and a rich-text note window.
// @include         main
// ==/UserScript==

(() => {
  "use strict";

  if (window.__zolfModsTabNotesLoaded) return;
  window.__zolfModsTabNotesLoaded = true;

  const ROOT = "mod.zolfmods.tab-notes.";
  const LOG = "[ZolfModsTabNotes]";

  // ---------------------------------------------------------------------
  // Notes are stored twice:
  //  1. in the tab's session data (SessionStore custom value) - this is what
  //     makes a note survive "restore closed tab";
  //  2. in <profile>/zolfmods-tab-notes.json, keyed by the tab's id - this
  //     is what makes a note survive closing the browser / rebooting even for
  //     pinned tabs and Essentials, which Zen rebuilds on its own.
  //
  // A note is a tiny subset of HTML (b, i, u, s, br). It is never inserted
  // with innerHTML: it is parsed, whitelisted and rebuilt node by node.
  // ---------------------------------------------------------------------
  const TabNotes = (() => {
    const PREF_INDICATOR = ROOT + "indicator";
    const KEY = "ztn-note";
    const LEGACY_KEY = "rzt-note"; // saved by the old RandomZenTweaks mod
    const HTML_PREFIX = "rzt:html:"; // unchanged on purpose: keeps notes saved by RandomZenTweaks readable
    const XHTML = "http://www.w3.org/1999/xhtml";
    const STORE_FILE = PathUtils.join(PathUtils.profileDir, "zolfmods-tab-notes.json");
    const LEGACY_STORE_FILE = PathUtils.join(PathUtils.profileDir, "randomzentweaks-notes.json");
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

    let enabled = true;
    let menuItem = null;
    let card = null;
    let scrim = null;
    const els = {};
    let cardTab = null;
    let cardMode = null; // "peek" (hover) | "edit"
    let lastSaved = "";
    let openedAt = 0;
    let showTimer = 0;
    let hideTimer = 0;
    let saveTimer = 0;
    let scrimTimer = 0;
    let anchorEl = null;
    let overIndicator = false;

    let store = {}; // tab id -> { t: stored value, u: updated }
    let flushTimer = 0;

    const h = (tag, cls, text) => {
      const el = document.createElementNS(XHTML, tag);
      if (cls) el.className = cls;
      if (text) el.textContent = text;
      return el;
    };

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
    const keyOf = (tab) => tab.id || "";

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

    function getRaw(tab) {
      let value = "";
      try {
        value = SS.getCustomTabValue(tab, KEY) || SS.getCustomTabValue(tab, LEGACY_KEY) || "";
      } catch (e) {}
      if (!value) {
        const k = keyOf(tab);
        if (k && store[k]) value = store[k].t || "";
      }
      return value;
    }

    const getHtml = (tab) => {
      const raw = getRaw(tab);
      return raw ? rawToHtml(raw) : "";
    };
    const tabHasNote = (tab) => hasText(getHtml(tab));

    function saveNote(tab, html) {
      const has = hasText(html);
      const raw = HTML_PREFIX + html;
      try {
        if (has) SS.setCustomTabValue(tab, KEY, raw);
        else SS.deleteCustomTabValue(tab, KEY);
      } catch (e) {
        console.error(LOG, "could not save note to the session", e);
      }
      const k = keyOf(tab);
      if (k) {
        if (has) store[k] = { t: raw, u: Date.now() };
        else delete store[k];
        flushStore();
      }
      refresh(tab);
    }

    // ---- indicator on the tab ----
    const indicatorMode = () =>
      Services.prefs.getStringPref(PREF_INDICATOR, "") === "icon" ? "icon" : "ribbon";

    function createIndicator(tab, mode, essential) {
      const content = tab.querySelector(".tab-content");
      if (!content) return null;

      const ind = h("div", "ztn-note-indicator " + (mode === "icon" ? "ztn-note-icon" : "ztn-note-ribbon"));
      ind.addEventListener("mouseenter", () => {
        overIndicator = true; // keeps the tab tooltip / preview from showing over it
        try {
          document.getElementById("tab-preview-panel")?.hidePopup();
        } catch (e) {}
        scheduleShow(tab);
      });
      ind.addEventListener("mouseleave", () => {
        overIndicator = false;
        scheduleHide(180);
      });
      ind.addEventListener("mousedown", (e) => e.stopPropagation());
      ind.addEventListener("click", (e) => {
        e.stopPropagation();
        openCard(tab, "edit", ind);
      });

      if (mode === "icon" && !essential) {
        // regular tabs: right next to the mute button
        ind.classList.add("ztn-note-inline");
        const ref = content.querySelector(".tab-audio-button") || content.querySelector(".tab-icon-stack");
        if (ref) ref.after(ind);
        else content.appendChild(ind);
      } else {
        content.appendChild(ind);
      }
      return ind;
    }

    function refresh(tab) {
      if (!tab || tab.closing) return;
      let ind = tab._ztnIndicator;
      const raw = enabled ? getRaw(tab) : "";

      if (!raw || !hasText(rawToHtml(raw))) {
        tab.removeAttribute("ztn-note");
        if (ind) ind.remove();
        tab._ztnIndicator = null;
        return;
      }

      tab.setAttribute("ztn-note", "true");

      // keep the session copy in sync when the note came from the file
      try {
        if (!SS.getCustomTabValue(tab, KEY)) SS.setCustomTabValue(tab, KEY, raw);
      } catch (e) {}

      const mode = indicatorMode();
      const essential = tab.hasAttribute("zen-essential");
      const kind = mode + (essential ? "-essential" : "-regular");
      if (ind && ind.isConnected && ind.dataset.ztnKind === kind) return;

      if (ind) ind.remove();
      ind = createIndicator(tab, mode, essential);
      if (!ind) return;
      ind.dataset.ztnKind = kind;
      tab._ztnIndicator = ind;
    }

    function refreshAll() {
      for (const tab of gBrowser.tabs) refresh(tab);
    }

    // ---- the note window (rich text, auto-saving, no buttons) ----
    function updateFormatButtons() {
      if (!els.fmt) return;
      for (const [cmd] of FORMAT_BUTTONS) {
        let on = false;
        try {
          on = document.queryCommandState(cmd);
        } catch (e) {}
        els.fmt[cmd].classList.toggle("active", on);
      }
    }

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(commit, 250);
    }

    function buildCard() {
      if (card) return;

      // transparent layer under the window while editing: the first click outside
      // only closes the window and never reaches the page / the tabs behind it
      scrim = h("div", "ztn-note-scrim");
      scrim.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeCard(true);
      });
      for (const type of ["mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
        scrim.addEventListener(type, (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (type === "click" || type === "auxclick" || type === "contextmenu") releaseScrim();
        });
      }

      card = h("div", "ztn-note-card");

      const head = h("div", "ztn-note-head");
      els.title = h("span", "ztn-note-title");
      els.fmt = {};
      const bar = h("div", "ztn-note-fmt");
      bar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      for (const [cmd, glyph, title] of FORMAT_BUTTONS) {
        const b = h("button", "ztn-note-fmt-btn ztn-fmt-" + cmd, glyph);
        b.setAttribute("title", title);
        b.addEventListener("click", () => {
          els.text.focus();
          document.execCommand(cmd);
          updateFormatButtons();
          scheduleSave();
        });
        els.fmt[cmd] = b;
        bar.append(b);
      }
      head.append(h("span", "ztn-note-label", "Note"), els.title, bar);

      els.text = h("div", "ztn-note-text");
      els.text.setAttribute("contenteditable", "true");
      els.text.setAttribute("spellcheck", "false");
      els.text.setAttribute("data-placeholder", "Write a note for this tab…");

      card.append(head, els.text);

      card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
      card.addEventListener("mouseleave", () => {
        if (cardMode === "peek") scheduleHide(90);
      });
      card.addEventListener("mousedown", (e) => e.stopPropagation());

      els.text.addEventListener("input", () => {
        if (els.text.textContent === "" && !els.text.querySelector("br:not(:only-child)")) {
          els.text.replaceChildren(); // lets the placeholder show again
        }
        clampVertical();
        scheduleSave();
        updateFormatButtons();
      });
      els.text.addEventListener("focus", () => {
        try {
          document.execCommand("styleWithCSS", false, false);
        } catch (e) {}
        if (cardMode === "peek") setMode("edit");
      });
      els.text.addEventListener("blur", (e) => {
        if (cardMode !== "edit" || !card.hasAttribute("open")) return;
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        if (Date.now() - openedAt < 500) {
          // the context menu was still closing and stole the focus back
          setTimeout(() => els.text.focus(), 0);
          return;
        }
        closeCard(true);
      });
      els.text.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          closeCard(true);
        } else if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          if (e.shiftKey) document.execCommand("insertLineBreak");
          else closeCard(true); // Enter closes, Shift+Enter = new line
        }
      });
      for (const type of ["keyup", "keypress"]) {
        els.text.addEventListener(type, (e) => e.stopPropagation());
      }
      els.text.addEventListener("paste", (e) => {
        e.preventDefault(); // plain text only
        const text = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
        text.split("\n").forEach((line, i) => {
          if (i) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
      });
      els.text.addEventListener("drop", (e) => e.preventDefault());

      document.addEventListener("selectionchange", () => {
        if (card.hasAttribute("open")) updateFormatButtons();
      });
    }

    function activateScrim() {
      clearTimeout(scrimTimer);
      scrim.setAttribute("active", "");
    }
    function releaseScrim() {
      clearTimeout(scrimTimer);
      scrim?.removeAttribute("active");
    }

    function setMode(mode) {
      cardMode = mode;
      card.dataset.mode = mode;
      if (mode === "edit") activateScrim();
    }

    // The window is placed ONCE when it opens (and again only on a window resize).
    // It must not follow the tab afterwards: with an expand-on-hover sidebar the tab
    // moves to the left as soon as the pointer leaves the sidebar.
    function place() {
      if (!card) return;
      const anchor = anchorEl && anchorEl.isConnected ? anchorEl : cardTab;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const cw = card.offsetWidth || 300;
      const ch = card.offsetHeight || 120;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = r.right + 10;
      if (left + cw > vw - 8) left = Math.max(8, r.left - cw - 10);
      const top = Math.min(Math.max(8, r.top - 4), Math.max(8, vh - ch - 8));
      card.style.left = left + "px";
      card.style.top = top + "px";
    }

    function clampVertical() {
      if (!card) return;
      const r = card.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom > vh - 8) card.style.top = Math.max(8, vh - 8 - r.height) + "px";
    }

    function commit() {
      clearTimeout(saveTimer);
      if (!cardTab || !els.text) return;
      const html = serialize(els.text);
      if (html === lastSaved) return;
      lastSaved = html;
      saveNote(cardTab, html);
    }

    function openCard(tab, mode, anchor) {
      if (!enabled || !tab) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);

      const isOpen = card && card.hasAttribute("open");
      if (isOpen && cardTab === tab) {
        if (mode === "edit" && cardMode !== "edit") {
          setMode("edit");
          els.text.focus();
        }
        return;
      }
      if (isOpen) closeCard(true);

      buildCard();
      if (!scrim.isConnected) document.documentElement.appendChild(scrim);
      if (!card.isConnected) document.documentElement.appendChild(card);

      cardTab = tab;
      anchorEl = anchor || tab;
      renderInto(els.text, getHtml(tab));
      lastSaved = serialize(els.text);
      els.title.textContent = tab.label || "";
      openedAt = Date.now();
      updateFormatButtons();

      place();
      card.setAttribute("open", "");
      setMode(mode);

      if (mode === "edit") {
        els.text.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(els.text);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    function closeCard(save) {
      if (!card || !card.hasAttribute("open")) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (save) commit();
      else clearTimeout(saveTimer);
      card.removeAttribute("open");
      cardTab = null;
      cardMode = null;
      anchorEl = null;
      if (document.activeElement === els.text) els.text.blur();
      // keep swallowing the click that closed the window (released on `click`, or after a moment)
      if (scrim?.hasAttribute("active")) {
        clearTimeout(scrimTimer);
        scrimTimer = setTimeout(releaseScrim, 350);
      }
    }

    function scheduleShow(tab) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(() => openCard(tab, "peek", tab._ztnIndicator), 140);
    }

    function scheduleHide(delay) {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (cardMode === "peek") closeCard(true);
      }, delay);
    }

    function deleteNote(tab) {
      if (cardTab === tab) closeCard(false);
      saveNote(tab, "");
    }

    // ---- tab tooltip / hover preview must not show while the pointer is on the indicator ----
    function onAnyPopupShowing(e) {
      if (!overIndicator) return;
      const t = e.target;
      if (t.localName === "tooltip" || /tooltip|preview/i.test(t.id || "")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    // ---- "Add Note..." / "Delete Note..." in the tab context menu ----
    function noteIconUri(color) {
      const svg =
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
        "<path fill='" + color + "' d='M3 1.5h10A1.5 1.5 0 0 1 14.5 3v5.5h-4a2 2 0 0 0-2 2v4H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5Z'/>" +
        "<path fill='" + color + "' fill-opacity='0.55' d='M14.5 9.5 9.5 14.5v-3a2 2 0 0 1 2-2Z'/></svg>";
      return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    }

    // The icon is drawn with a concrete color (read from the menu item) instead of
    // context-fill, and it follows whichever icon style the neighbouring items use.
    function paintMenuIcon() {
      if (!menuItem) return;
      const sibling = menuItem.nextElementSibling;
      const iconic = !!sibling?.classList.contains("menuitem-iconic");
      let color = "#e8e8ee";
      try {
        const c = getComputedStyle(menuItem).color;
        if (c && c !== "rgba(0, 0, 0, 0)") color = c;
      } catch (e) {}
      menuItem.style.setProperty("--ztn-menu-icon", noteIconUri(color));
      menuItem.classList.toggle("menuitem-iconic", iconic);
      menuItem.toggleAttribute("ztn-iconic", iconic);
    }

    function onPopupShowing(e) {
      const popup = e.target;
      if (popup.id !== "tabContextMenu" || !menuItem) return;
      const tab = window.TabContextMenu?.contextTab;
      menuItem.setAttribute("label", tab && tabHasNote(tab) ? "Delete Note..." : "Add Note...");
      menuItem.hidden = !tab;
      paintMenuIcon();
    }

    function ensureMenu() {
      const popup = document.getElementById("tabContextMenu");
      if (!popup) return;

      if (!menuItem) {
        menuItem = document.createXULElement("menuitem");
        menuItem.id = "context_ztn-add-note";
        menuItem.setAttribute("label", "Add Note...");
        menuItem.addEventListener("command", () => {
          const tab = window.TabContextMenu?.contextTab;
          if (!tab) return;
          if (tabHasNote(tab)) deleteNote(tab);
          else setTimeout(() => openCard(tab, "edit", tab), 80);
        });
      }

      // directly above "Change Label..."
      const anchor = popup.querySelector(
        '#context_zen-edit-tab-title, [data-l10n-id="tab-context-zen-edit-title"]'
      );
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(menuItem, anchor);
      else popup.insertBefore(menuItem, popup.firstElementChild);
    }

    function init() {
      document.getElementById("tabContextMenu")?.addEventListener("popupshowing", onPopupShowing);
      document.addEventListener("popupshowing", onAnyPopupShowing, true);

      const tabs = gBrowser.tabContainer;
      tabs.addEventListener("SSTabRestored", (e) => refresh(e.target));
      tabs.addEventListener("TabClose", (e) => {
        if (cardTab === e.target) closeCard(true);
      });
      window.addEventListener("SSWindowStateReady", refreshAll);
      window.addEventListener("resize", () => {
        if (card?.hasAttribute("open")) place();
      });

      // a tab can become / stop being an Essential at any time
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.target?.localName === "tab") refresh(r.target);
        }
      }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["zen-essential"] });

      ensureMenu();
      loadStore();
      // session data can arrive a little after startup
      setTimeout(refreshAll, 2000);
      setTimeout(refreshAll, 6000);
      setTimeout(pruneStore, 15000);
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

// Interactive widgets besides memviz:
//   <div class="rfc-widget" data-widget="timeline" data-name="vec-push"></div>
//   <div class="rfc-widget" data-widget="arena"></div>
(function () {
  "use strict";
  var RFC = (window.RFC = window.RFC || {});
  var SVGNS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    if (parent) parent.appendChild(e);
    return e;
  }

  // ------------------------------------------------------------------
  // Borrow timeline: shows, line by line, where each borrow is alive
  // (non-lexical lifetimes) and where two of them collide.
  // ------------------------------------------------------------------
  var timelines = {};
  RFC.timeline = { define: function (n, d) { timelines[n] = d; } };

  function mountTimeline(box) {
    var def = timelines[box.getAttribute("data-name")];
    if (!def) { box.textContent = "[missing timeline]"; return; }
    box.setAttribute("tabindex", "0");
    if (def.title) h("div", "rw-title", box, RFC.t(def.title));
    var tabs = h("div", "mv-tabs", box);
    var stage = h("div", "", box);

    function show(v) {
      stage.innerHTML = "";
      var grid = h("div", "bt-grid", stage);
      var code = h("pre", "bt-code", grid);
      var lines = v.code.map(function (l, i) {
        var d = h("div", "bt-line", code);
        var no = h("span", "mv-lineno", d, String(i + 1));
        d.appendChild(document.createTextNode(l || " "));
        if ((v.conflict || []).indexOf(i) >= 0) d.classList.add("bt-conflict");
        return d;
      });
      var bars = h("div", "bt-bars", grid);
      var LH = parseFloat(getComputedStyle(lines[0]).height) || 22;
      var COL = 72;
      var svg = el("svg", { width: v.bars.length * COL + 24, height: v.code.length * LH }, bars);
      var groups = [];
      v.bars.forEach(function (b, i) {
        var g = el("g", { class: "bt-bar bt-" + b.kind }, svg);
        var x = i * COL + 6;
        var y0 = b.from * LH + 3, y1 = (b.to + 1) * LH - 3;
        el("rect", { x: x, y: y0, width: 14, height: Math.max(6, y1 - y0) }, g);
        var t = el("text", { x: x + 19, y: y0 + 12 }, g);
        t.textContent = b.name;
        var tt = el("title", {}, g);
        tt.textContent = RFC.t(b.kind === "mut" ? "mutable borrow" : b.kind === "shared" ? "shared borrow" : "owner") + ": " + b.name;
        groups.push(g);
        function on() {
          groups.forEach(function (o) { o.classList.toggle("bt-dim", o !== g); });
          lines.forEach(function (l, n) { l.classList.toggle("bt-hot", n >= b.from && n <= b.to); });
        }
        function off() {
          groups.forEach(function (o) { o.classList.remove("bt-dim"); });
          lines.forEach(function (l) { l.classList.remove("bt-hot"); });
        }
        g.addEventListener("mouseenter", on);
        g.addEventListener("mouseleave", off);
        g.addEventListener("click", on);
      });
      (v.conflict || []).forEach(function (ln) {
        var y = ln * LH + LH / 2;
        var x = v.bars.length * COL + 12;
        el("line", { x1: x - 5, y1: y - 5, x2: x + 5, y2: y + 5, class: "bt-x" }, svg);
        el("line", { x1: x - 5, y1: y + 5, x2: x + 5, y2: y - 5, class: "bt-x" }, svg);
      });
      if (v.error) {
        h("div", "mv-error", stage, v.error);
      }
      if (v.note) {
        var n = h("div", "mv-note", stage);
        n.innerHTML = RFC.richText(RFC.t(v.note));
      }
      var legend = h("div", "mv-legend", stage);
      legend.innerHTML =
        '<span class="mv-key mv-key-own"></span>' + RFC.t("owner alive") +
        '<span class="mv-key mv-key-shared"></span>' + RFC.t("shared borrow alive") +
        '<span class="mv-key mv-key-mut"></span>' + RFC.t("mutable borrow alive") +
        " · " + RFC.t("hover a bar to see its lines");
    }

    def.variants.forEach(function (v, i) {
      var b = h("button", "mv-tab", tabs, RFC.t(v.label));
      b.type = "button";
      b.addEventListener("click", function () {
        tabs.querySelectorAll(".mv-tab").forEach(function (t, n) { t.classList.toggle("mv-tab-active", n === i); });
        show(v);
      });
    });
    tabs.firstChild.click();
  }

  // ------------------------------------------------------------------
  // Generational arena playground: raw pointers vs generational handles.
  // ------------------------------------------------------------------
  function mountArena(box) {
    var N = 6;
    var KINDS = ["Player", "Enemy", "Bullet", "Light", "Camera", "Tree", "Enemy", "Bullet"];
    var st;
    function reset() {
      st = { slots: [], free: [], handles: [], next: 1, sel: -1, mode: "handle", log: [] };
      for (var i = 0; i < N; i++) st.slots.push({ gen: 0, val: null });
      for (var j = N - 1; j >= 0; j--) st.free.push(j);
    }
    reset();
    box.setAttribute("tabindex", "0");
    h("div", "rw-title", box, RFC.t("Generational arena playground"));
    var modeRow = h("div", "rw-row rw-mode", box);
    var modes = [
      ["pointer", RFC.t("C++ style: raw pointer / plain index")],
      ["handle", RFC.t("Rust style: generational handle")]
    ];
    var name = "arena-mode-" + Math.random().toString(36).slice(2);
    modes.forEach(function (m) {
      var lab = h("label", "", modeRow);
      var r = h("input", "", lab);
      r.type = "radio"; r.name = name; r.value = m[0];
      r.checked = m[0] === st.mode;
      r.addEventListener("change", function () { st.mode = m[0]; draw(); });
      lab.appendChild(document.createTextNode(" " + m[1] + "  "));
    });
    var btnRow = h("div", "rw-row", box);
    var bSpawn = h("button", "rw-btn", btnRow, RFC.t("Spawn entity"));
    var bKill = h("button", "rw-btn rw-danger", btnRow, RFC.t("Despawn selected"));
    var bGet = h("button", "rw-btn", btnRow, RFC.t("Read through selected handle"));
    var bReset = h("button", "rw-btn", btnRow, RFC.t("Reset"));
    [bSpawn, bKill, bGet, bReset].forEach(function (b) { b.type = "button"; });
    var svg = el("svg", { class: "rw-svg", viewBox: "0 0 600 226" }, box);
    var log = h("div", "rw-log", box);
    var hint = h("div", "mv-note", box);

    function say(cls, s) {
      st.log.push([cls, s]);
      if (st.log.length > 40) st.log.shift();
    }
    function handleLabel(hd) {
      return st.mode === "handle"
        ? "#" + hd.index + " g" + hd.gen
        : "&slot[" + hd.index + "]";
    }
    function stale(hd) {
      var s = st.slots[hd.index];
      return !(s.val && s.gen === hd.gen);
    }

    bSpawn.addEventListener("click", function () {
      if (!st.free.length) { say("rw-none", RFC.t("Arena full: despawn something first.")); draw(); return; }
      var i = st.free.pop();
      var s = st.slots[i];
      s.val = RFC.t(KINDS[(st.next - 1) % KINDS.length]) + " " + st.next++;
      st.handles.push({ index: i, gen: s.gen, of: s.val });
      st.sel = st.handles.length - 1;
      say("rw-ok", RFC.t("spawn") + " → " + s.val + "  (" + RFC.t("slot") + " " + i + ", " + RFC.t("generation") + " " + s.gen + ")");
      draw();
    });
    bKill.addEventListener("click", function () {
      var hd = st.handles[st.sel];
      if (!hd) return;
      var s = st.slots[hd.index];
      if (st.mode === "handle" && stale(hd)) {
        say("rw-none", RFC.t("despawn ignored: handle is stale, the slot holds something else now"));
      } else if (!s.val) {
        say("rw-ub", RFC.t("double free! (undefined behavior in C++)"));
      } else if (s.val !== hd.of) {
        say("rw-ub", RFC.t("deleted") + " " + s.val + " " + RFC.t("instead of") + " " + hd.of + "! " + RFC.t("the pointer outlived its object"));
        s.val = null;
        s.gen += 1;
        st.free.push(hd.index);
      } else {
        say("rw-ok", RFC.t("despawn") + " → " + s.val + "  (" + RFC.t("slot") + " " + hd.index + " " + RFC.t("goes on the free list") + ")");
        s.val = null;
        s.gen += 1; // bump the generation so every old handle to this slot goes stale
        st.free.push(hd.index);
      }
      draw();
    });
    bGet.addEventListener("click", function () {
      var hd = st.handles[st.sel];
      if (!hd) return;
      var s = st.slots[hd.index];
      if (st.mode === "handle") {
        if (stale(hd)) say("rw-none", "arena.get(" + handleLabel(hd) + ") → None   // " + RFC.t("generation mismatch: the entity is gone"));
        else say("rw-ok", "arena.get(" + handleLabel(hd) + ") → Some(" + s.val + ")");
      } else {
        if (!s.val) say("rw-ub", "*ptr → " + RFC.t("reads freed memory (use-after-free)"));
        else if (s.val !== hd.of) say("rw-ub", "*ptr → " + s.val + "   // " + RFC.t("expected") + " " + hd.of + "! " + RFC.t("silent use-after-free"));
        else say("rw-ok", "*ptr → " + s.val);
      }
      draw();
    });
    bReset.addEventListener("click", function () { var m = st.mode; reset(); st.mode = m; draw(); });

    function draw() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var SW = 92, SX = 18, SY = 34, SH = 62;
      var t = el("text", { x: SX, y: 20, class: "rw-label" }, svg);
      t.textContent = RFC.t("ARENA (one contiguous array)");
      st.slots.forEach(function (s, i) {
        var g = el("g", { class: "rw-slot" + (s.val ? " rw-occupied" : "") }, svg);
        var x = SX + i * (SW + 4);
        el("rect", { x: x, y: SY, width: SW, height: SH, rx: 5, class: "rw-slot-box" }, g);
        var a = el("text", { x: x + 6, y: SY + 16, class: "rw-gen" }, g);
        a.textContent = "[" + i + "]" + (st.mode === "handle" ? "  g" + s.gen : "");
        var b = el("text", { x: x + 6, y: SY + 40, class: s.val ? "" : "rw-free" }, g);
        b.textContent = s.val || RFC.t("free");
      });
      var hy = 150;
      var t2 = el("text", { x: SX, y: hy + 66, class: "rw-label" }, svg);
      t2.textContent = RFC.t("HANDLES HELD BY GAME CODE (click to select)");
      var HW = 88;
      st.handles.slice(-6).forEach(function (hd, k) {
        var idx = st.handles.length - Math.min(6, st.handles.length) + k;
        var isStale = stale(hd);
        var x = SX + k * (HW + 8);
        var sx = SX + hd.index * (SW + 4) + SW / 2;
        var cls = "rw-link" + (isStale ? " rw-stale" : "");
        el("path", { d: "M" + (x + HW / 2) + "," + hy + " C" + (x + HW / 2) + "," + (hy - 30) + " " + sx + "," + (SY + SH + 30) + " " + sx + "," + (SY + SH + 2), class: cls }, svg);
        var g = el("g", { class: "rw-handle" + (isStale ? " rw-stale" : "") + (idx === st.sel ? " rw-active" : "") }, svg);
        el("rect", { x: x, y: hy, width: HW, height: 46, rx: 5 }, g);
        var l1 = el("text", { x: x + 6, y: hy + 18 }, g);
        l1.textContent = handleLabel(hd);
        var l2 = el("text", { x: x + 6, y: hy + 36, class: "rw-gen" }, g);
        l2.textContent = "(" + hd.of + ")";
        g.addEventListener("click", function () { st.sel = idx; draw(); });
      });
      log.innerHTML = "";
      st.log.forEach(function (e) { h("div", e[0], log, e[1]); });
      log.scrollTop = log.scrollHeight;
      bKill.disabled = bGet.disabled = st.sel < 0;
      hint.innerHTML = RFC.richText(RFC.t(st.mode === "handle"
        ? "Try it: spawn two entities, despawn the first, spawn again (it reuses the slot), then read through the **old** handle. The generation no longer matches, so you get `None` instead of the wrong entity."
        : "Try it: spawn two entities, despawn the first, spawn again (it reuses the slot), then read through the **old** pointer. You get a different entity and nothing tells you. This is the bug class handles remove."));
    }
    draw();
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".rfc-widget[data-widget]").forEach(function (box) {
      var w = box.getAttribute("data-widget");
      if (w === "timeline") mountTimeline(box);
      else if (w === "arena") mountArena(box);
    });
  });
})();

// memviz: step-through stack/heap diagrams.
//
// Usage in Markdown:
//   <div class="rfc-memviz" data-diagram="ownership-move"></div>
//
// A diagram definition (registered with RFC.memviz.define) is either a single
// "variant" or a list of variants shown as tabs (for example C++ and Rust):
//
//   {
//     variants: [{
//       label: "Rust",
//       code: ["fn main() {", "    let a = String::from(\"hi\");", ...],
//       steps: [{
//         line: 1,                       // highlighted code line (0-based)
//         note: "text with `code`",      // explanation shown under the diagram
//         error: "E0382: ...",           // optional compiler error box
//         frames: [{ name: "main", slots: [
//           { id: "a", name: "a", type: "String",
//             fields: ["ptr", "len 2", "cap 2"],
//             state: "live" | "moved" | "dropped" | "uninit" | "borrowed" | "frozen" }
//         ]}],
//         heap: [{ id: "h1", cells: ["h", "i"], state: "live" | "freed" }],
//         arrows: [{ from: "a", to: "h1", kind: "own" | "shared" | "mut" | "dangling" }]
//       }]
//     }]
//   }
//
// Every user-visible string goes through RFC.t() so it can be translated.
(function () {
  "use strict";
  var RFC = (window.RFC = window.RFC || {});
  var SVGNS = "http://www.w3.org/2000/svg";
  var defs = {};

  var W = 560;
  var STACK_X = 40, STACK_W = 232;
  var HEAP_X = 330, HEAP_W = 200;
  var SLOT_H = 50, FRAME_HEAD = 24, FRAME_GAP = 12, HEAP_GAP = 14, TOP = 34;
  var CELL_W = 26, CELL_H = 30;

  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function text(parent, x, y, s, cls, anchor) {
    var t = el("text", { x: x, y: y, class: cls || "", "text-anchor": anchor || "start" }, parent);
    t.textContent = s;
    return t;
  }

  function frameHeight(f) {
    return FRAME_HEAD + f.slots.length * SLOT_H + 8;
  }

  function stepHeight(step) {
    var h = TOP;
    (step.frames || []).forEach(function (f) { h += frameHeight(f) + FRAME_GAP; });
    var hh = TOP;
    (step.heap || []).forEach(function (b) { hh += blockHeight(b) + HEAP_GAP; });
    return Math.max(h, hh) + 6;
  }

  function blockHeight(b) {
    var rows = Math.max(1, Math.ceil((b.cells || []).length / 7));
    return 22 + rows * CELL_H + 8;
  }

  function renderStep(svg, step, prev) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var defsEl = el("defs", {}, svg);
    ["own", "shared", "mut", "dangling"].forEach(function (k) {
      var m = el("marker", {
        id: svg.dataset.uid + "-arrow-" + k, viewBox: "0 0 10 10", refX: 9, refY: 5,
        markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse"
      }, defsEl);
      el("path", { d: "M0,0 L10,5 L0,10 z", class: "mv-arrowhead mv-" + k }, m);
    });

    text(svg, STACK_X, 20, RFC.t("Stack"), "mv-col-title");
    text(svg, HEAP_X, 20, RFC.t("Heap"), "mv-col-title");

    var prevSlots = {}, prevHeap = {};
    if (prev) {
      (prev.frames || []).forEach(function (f) { f.slots.forEach(function (s) { prevSlots[s.id] = s; }); });
      (prev.heap || []).forEach(function (b) { prevHeap[b.id] = b; });
    }

    var anchors = {};
    var y = TOP;
    (step.frames || []).forEach(function (f) {
      var fh = frameHeight(f);
      var g = el("g", { class: "mv-frame" }, svg);
      el("rect", { x: STACK_X, y: y, width: STACK_W, height: fh, rx: 6, class: "mv-frame-box" }, g);
      text(g, STACK_X + 8, y + 16, RFC.t(f.name), "mv-frame-name");
      var sy = y + FRAME_HEAD;
      f.slots.forEach(function (s) {
        var p = prevSlots[s.id];
        var changed = !p || p.state !== s.state || JSON.stringify(p.fields) !== JSON.stringify(s.fields);
        var state = s.state || "live";
        var sg = el("g", { class: "mv-slot mv-" + state + (changed ? " mv-changed" : "") }, g);
        el("rect", { x: STACK_X + 8, y: sy + 3, width: STACK_W - 16, height: SLOT_H - 6, rx: 4, class: "mv-slot-box" }, sg);
        text(sg, STACK_X + 16, sy + 22, s.name, "mv-slot-name");
        if (s.type) text(sg, STACK_X + 16, sy + 38, s.type, "mv-slot-type");
        var fields = s.fields || (s.value != null ? [s.value] : []);
        var fx = STACK_X + STACK_W - 14;
        for (var i = fields.length - 1; i >= 0; i--) {
          var label = String(fields[i]);
          var w = Math.max(30, label.length * 7 + 12);
          fx -= w;
          el("rect", { x: fx, y: sy + 8, width: w, height: 22, rx: 3, class: "mv-field" }, sg);
          text(sg, fx + w / 2, sy + 23, label, "mv-field-text", "middle");
          fx -= 3;
        }
        if (state !== "live" && state !== "borrowed") {
          var tag = { moved: "moved", dropped: "dropped", uninit: "uninitialized", frozen: "frozen", dead: "borrow ended", ub: "valid but unspecified" }[state] || state;
          text(sg, STACK_X + STACK_W - 14, sy + 42, RFC.t(tag), "mv-state-tag", "end");
        }
        anchors[s.id] = { x: STACK_X + STACK_W - 8, y: sy + SLOT_H / 2, left: STACK_X + 8 };
        sy += SLOT_H;
      });
      y += fh + FRAME_GAP;
    });

    var hy = TOP;
    (step.heap || []).forEach(function (b) {
      var bh = blockHeight(b);
      var p = prevHeap[b.id];
      var changed = !p || p.state !== b.state || JSON.stringify(p.cells) !== JSON.stringify(b.cells);
      var state = b.state || "live";
      var g = el("g", { class: "mv-block mv-" + state + (changed ? " mv-changed" : "") }, svg);
      el("rect", { x: HEAP_X, y: hy, width: HEAP_W, height: bh, rx: 6, class: "mv-block-box" }, g);
      text(g, HEAP_X + 8, hy + 15, b.label ? RFC.t(b.label) : "", "mv-block-label");
      if (state === "freed") text(g, HEAP_X + HEAP_W - 8, hy + 15, RFC.t("freed"), "mv-state-tag", "end");
      (b.cells || []).forEach(function (c, i) {
        var cx = HEAP_X + 8 + (i % 7) * CELL_W, cy = hy + 22 + Math.floor(i / 7) * CELL_H;
        el("rect", { x: cx, y: cy, width: CELL_W - 2, height: CELL_H - 4, rx: 2, class: "mv-cell" + (c === "" ? " mv-cell-spare" : "") }, g);
        text(g, cx + (CELL_W - 2) / 2, cy + 18, c, "mv-cell-text", "middle");
      });
      anchors[b.id] = { x: HEAP_X, y: hy + bh / 2, right: HEAP_X + HEAP_W, heap: true };
      hy += bh + HEAP_GAP;
    });

    (step.arrows || []).forEach(function (a) {
      var f = anchors[a.from], t = anchors[a.to];
      if (!f || !t) return;
      var kind = a.kind || "own";
      var d;
      if (f.heap && t.heap) {
        // heap -> heap (e.g. an object's vptr to its vtable): loop around the right edge
        var rx = f.right + 22;
        d = "M" + f.right + "," + f.y + " C" + rx + "," + f.y + " " + rx + "," + t.y + " " + (t.right + 2) + "," + t.y;
      } else if (t.x > f.x) {
        var mx = (f.x + t.x) / 2;
        d = "M" + f.x + "," + f.y + " C" + mx + "," + f.y + " " + mx + "," + t.y + " " + (t.x - 2) + "," + t.y;
      } else {
        // stack -> stack (a reference to another local): loop around the left edge
        var lx = STACK_X - 2;
        var fx2 = f.left, tx = t.left;
        d = "M" + fx2 + "," + f.y + " C" + (lx - 30) + "," + f.y + " " + (lx - 30) + "," + t.y + " " + (tx - 1) + "," + t.y;
      }
      el("path", {
        d: d, class: "mv-arrow mv-" + kind,
        "marker-end": "url(#" + svg.dataset.uid + "-arrow-" + kind + ")"
      }, svg);
      if (kind === "dangling") {
        text(svg, (f.x + t.x) / 2, (f.y + t.y) / 2 - 6, "✗", "mv-dangling-x", "middle");
      }
    });
  }

  var uidCounter = 0;

  function mountVariant(container, v, ui) {
    ui.code.innerHTML = "";
    v.code.forEach(function (line, i) {
      var div = document.createElement("div");
      div.className = "mv-line";
      div.dataset.line = i;
      var no = document.createElement("span");
      no.className = "mv-lineno";
      no.textContent = i + 1;
      var src = document.createElement("span");
      src.className = "mv-src";
      src.textContent = line || " ";
      div.appendChild(no);
      div.appendChild(src);
      ui.code.appendChild(div);
    });
    ui.code.className = "mv-code" + (v.language ? " mv-lang-" + v.language : "");
    var maxH = 0;
    v.steps.forEach(function (s) { maxH = Math.max(maxH, stepHeight(s)); });
    ui.svg.setAttribute("viewBox", "0 0 " + W + " " + maxH);
    ui.slider.max = v.steps.length - 1;

    function go(i) {
      i = Math.max(0, Math.min(v.steps.length - 1, i));
      ui.index = i;
      var step = v.steps[i];
      renderStep(ui.svg, step, i > 0 ? v.steps[i - 1] : null);
      var lines = ui.code.querySelectorAll(".mv-line");
      var hl = [].concat(step.line == null ? [] : step.line);
      lines.forEach(function (l, n) {
        l.classList.toggle("mv-current", hl.indexOf(n) >= 0);
        l.classList.toggle("mv-error-line", !!step.error && hl.indexOf(n) >= 0);
      });
      ui.note.innerHTML = step.note ? RFC.richText(RFC.t(step.note)) : "";
      ui.err.style.display = step.error ? "" : "none";
      ui.err.textContent = step.error || "";
      ui.counter.textContent = RFC.t("Step") + " " + (i + 1) + " / " + v.steps.length;
      ui.slider.value = i;
      ui.prev.disabled = i === 0;
      ui.next.disabled = i === v.steps.length - 1;
    }
    ui.go = go;
    go(0);
  }

  function mount(container) {
    var name = container.getAttribute("data-diagram");
    var def = defs[name];
    if (!def) {
      container.textContent = "[missing diagram: " + name + "]";
      return;
    }
    var variants = def.variants || [def];
    container.innerHTML = "";
    container.setAttribute("tabindex", "0");

    if (def.title) {
      var title = document.createElement("div");
      title.className = "mv-title";
      title.textContent = RFC.t(def.title);
      container.appendChild(title);
    }

    var ui = {};
    if (variants.length > 1) {
      var tabs = document.createElement("div");
      tabs.className = "mv-tabs";
      tabs.setAttribute("role", "tablist");
      variants.forEach(function (v, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "mv-tab";
        b.setAttribute("role", "tab");
        b.textContent = RFC.t(v.label);
        b.addEventListener("click", function () {
          tabs.querySelectorAll(".mv-tab").forEach(function (t, n) {
            t.classList.toggle("mv-tab-active", n === i);
            t.setAttribute("aria-selected", n === i);
          });
          mountVariant(container, v, ui);
        });
        tabs.appendChild(b);
      });
      container.appendChild(tabs);
    }

    var body = document.createElement("div");
    body.className = "mv-body";
    ui.code = document.createElement("pre");
    body.appendChild(ui.code);
    ui.svg = el("svg", { class: "mv-svg", role: "img", preserveAspectRatio: "xMidYMin meet" });
    ui.svg.dataset.uid = "mv" + uidCounter++;
    var svgWrap = document.createElement("div");
    svgWrap.className = "mv-svg-wrap";
    svgWrap.appendChild(ui.svg);
    body.appendChild(svgWrap);
    container.appendChild(body);

    ui.err = document.createElement("div");
    ui.err.className = "mv-error";
    container.appendChild(ui.err);
    ui.note = document.createElement("div");
    ui.note.className = "mv-note";
    ui.note.setAttribute("aria-live", "polite");
    container.appendChild(ui.note);

    var controls = document.createElement("div");
    controls.className = "mv-controls";
    ui.prev = document.createElement("button");
    ui.prev.type = "button";
    ui.prev.textContent = "◀ " + RFC.t("Back");
    ui.next = document.createElement("button");
    ui.next.type = "button";
    ui.next.textContent = RFC.t("Next") + " ▶";
    ui.slider = document.createElement("input");
    ui.slider.type = "range";
    ui.slider.min = 0;
    ui.slider.setAttribute("aria-label", RFC.t("Step"));
    ui.counter = document.createElement("span");
    ui.counter.className = "mv-counter";
    controls.appendChild(ui.prev);
    controls.appendChild(ui.slider);
    controls.appendChild(ui.next);
    controls.appendChild(ui.counter);
    container.appendChild(controls);

    var legend = document.createElement("div");
    legend.className = "mv-legend";
    legend.innerHTML =
      '<span class="mv-key mv-key-own"></span>' + RFC.t("owns") +
      '<span class="mv-key mv-key-shared"></span>' + RFC.t("shared borrow (&)") +
      '<span class="mv-key mv-key-mut"></span>' + RFC.t("mutable borrow (&mut)") +
      '<span class="mv-key mv-key-dangling"></span>' + RFC.t("dangling");
    container.appendChild(legend);

    ui.prev.addEventListener("click", function () { ui.go(ui.index - 1); });
    ui.next.addEventListener("click", function () { ui.go(ui.index + 1); });
    ui.slider.addEventListener("input", function () { ui.go(+ui.slider.value); });
    container.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight") { ui.go(ui.index + 1); e.preventDefault(); }
      if (e.key === "ArrowLeft") { ui.go(ui.index - 1); e.preventDefault(); }
    });

    var first = variants[0];
    if (variants.length > 1) container.querySelector(".mv-tab").click();
    else mountVariant(container, first, ui);
  }

  RFC.memviz = {
    define: function (name, def) { defs[name] = def; },
    mountAll: function () {
      document.querySelectorAll(".rfc-memviz[data-diagram]").forEach(mount);
    }
  };

  document.addEventListener("DOMContentLoaded", function () { RFC.memviz.mountAll(); });
})();

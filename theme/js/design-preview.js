// Temporary design picker: lets readers compare candidate visual designs.
// Choose with the floating buttons or ?design=folio|blueprint|shader.
(function () {
  "use strict";
  var DESIGNS = [["folio", "A · Folio"], ["blueprint", "B · Blueprint"], ["shader", "C · Shader"]];
  var KEY = "rfc-design";
  var q = new URLSearchParams(location.search).get("design");
  var cur = q;
  if (!cur) { try { cur = localStorage.getItem(KEY); } catch (e) {} }
  if (!DESIGNS.some(function (d) { return d[0] === cur; })) cur = "folio";
  function apply(d) {
    document.documentElement.setAttribute("data-design", d);
    try { localStorage.setItem(KEY, d); } catch (e) {}
    document.querySelectorAll("#rfc-design-picker button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.d === d));
    });
  }
  apply(cur);
  document.addEventListener("DOMContentLoaded", function () {
    var bar = document.createElement("div");
    bar.id = "rfc-design-picker";
    var label = document.createElement("span");
    label.textContent = "Design preview";
    bar.appendChild(label);
    DESIGNS.forEach(function (d) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.d = d[0];
      b.textContent = d[1];
      b.addEventListener("click", function () { apply(d[0]); });
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
    apply(cur);
  });
})();

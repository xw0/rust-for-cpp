// Small UI tweaks: the theme menu shows Auto, Light and Dark only (see
// design.css), with labels translated for the current language. Callout
// titles are translated the same way.
(function () {
  "use strict";
  var LABELS = { default_theme: ["theme-auto", "Auto"], light: ["theme-light", "Light"], coal: ["theme-dark", "Dark"] };
  document.addEventListener("DOMContentLoaded", function () {
    var t = (window.RFC && RFC.t) || function (s) { return s; };
    Object.keys(LABELS).forEach(function (id) {
      var b = document.getElementById(id);
      if (!b) return;
      var key = LABELS[id][0], s = t(key);
      b.textContent = s === key ? LABELS[id][1] : s;
    });
    // Callout titles are raw HTML in the chapters, so gettext does not see
    // them; translate them from the widget string tables instead.
    document.querySelectorAll(".rfc-callout-title").forEach(function (el) {
      el.textContent = t(el.textContent.trim());
    });
  });
})();

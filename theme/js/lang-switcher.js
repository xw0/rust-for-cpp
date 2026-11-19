// Language switcher. English is built at the site root, each translation in a
// sub-directory named after its language code (see .github/workflows/pages.yml).
(function () {
  "use strict";
  var LANGS = [
    { code: "en", name: "English", dir: "" },
    { code: "zh-CN", name: "简体中文", dir: "zh-CN/" }
  ];

  function init() {
    var bar = document.querySelector("#menu-bar .right-buttons");
    if (!bar || typeof path_to_root === "undefined") return;
    var cur = (document.documentElement.getAttribute("lang") || "en").trim();
    var current = LANGS.filter(function (l) { return l.code === cur; })[0] || LANGS[0];

    // Root of the *current* language build, then the site root above it.
    var langRoot = new URL(path_to_root || "./", location.href);
    var siteRoot = new URL(current.dir ? "../" : "./", langRoot);
    var rel = location.href.slice(langRoot.href.length).split("#")[0];

    var wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.style.display = "inline-block";
    var btn = document.createElement("button");
    btn.id = "rfc-lang-toggle";
    btn.className = "icon-button";
    btn.type = "button";
    btn.title = "Language / 语言";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = current.code === "en" ? "EN · 中" : "中 · EN";
    var list = document.createElement("ul");
    list.id = "rfc-lang-list";
    list.className = "theme-popup";
    list.style.display = "none";
    LANGS.forEach(function (l) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.className = "theme";
      a.href = new URL(l.dir + rel, siteRoot).href;
      a.textContent = l.name;
      if (l.code === current.code) a.setAttribute("aria-current", "true");
      li.appendChild(a);
      list.appendChild(li);
    });
    btn.addEventListener("click", function (e) {
      var open = list.style.display === "none";
      list.style.display = open ? "block" : "none";
      btn.setAttribute("aria-expanded", String(open));
      e.stopPropagation();
    });
    document.addEventListener("click", function () { list.style.display = "none"; });
    wrap.appendChild(btn);
    wrap.appendChild(list);
    bar.insertBefore(wrap, bar.firstChild);
  }
  document.addEventListener("DOMContentLoaded", init);
})();

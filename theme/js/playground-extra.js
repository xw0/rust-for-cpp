// Adds "Open in Playground" under every runnable Rust example. The Playground
// page can show the generated assembly, LLVM IR and MIR (the "..." menu next
// to Run), which is the quickest way to check that an abstraction is free.
(function () {
  "use strict";
  function init() {
    var RFC = window.RFC || { t: function (s) { return s; } };
    document.querySelectorAll("pre.playground").forEach(function (pre) {
      var code = pre.querySelector("code");
      if (!code) return;
      var src = code.textContent;
      var edition = (code.className.match(/edition(\d{4})/) || [0, "2024"])[1];
      var a = document.createElement("a");
      a.className = "rfc-asm-link";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = RFC.t("Open in Playground (assembly, MIR) ↗");
      a.addEventListener("click", function () {
        // Read the code at click time so edits in the page are carried over.
        var live = window.ace && pre.querySelector(".ace_editor")
          ? window.ace.edit(pre.querySelector(".ace_editor")).getValue()
          : code.textContent;
        a.href = "https://play.rust-lang.org/?version=stable&mode=release&edition=" +
          edition + "&code=" + encodeURIComponent(live);
      });
      a.href = "https://play.rust-lang.org/?version=stable&mode=release&edition=" +
        edition + "&code=" + encodeURIComponent(src);
      var p = document.createElement("div");
      p.style.textAlign = "right";
      p.style.marginTop = "-0.6em";
      p.style.marginBottom = "1em";
      p.appendChild(a);
      pre.parentNode.insertBefore(p, pre.nextSibling);
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();

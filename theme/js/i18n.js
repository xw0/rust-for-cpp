// Minimal string lookup shared by all interactive widgets.
//
// Widgets are authored in English. Each translation registers a dictionary
// (English string -> translated string) with RFC.registerStrings(lang, dict),
// see i18n-zh-CN.js. Missing strings fall back to English, exactly like
// untranslated paragraphs in the gettext catalogs for the prose.
(function () {
  "use strict";
  var RFC = (window.RFC = window.RFC || {});
  var dicts = {};

  RFC.lang = function () {
    return (document.documentElement.getAttribute("lang") || "en").trim();
  };

  RFC.registerStrings = function (lang, dict) {
    dicts[lang] = Object.assign(dicts[lang] || {}, dict);
  };

  RFC.t = function (s) {
    var d = dicts[RFC.lang()];
    return (d && d[s]) || s;
  };

  // Escape, then render `code` spans and **bold** in short widget strings.
  RFC.richText = function (s) {
    var esc = String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return esc
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  };
})();

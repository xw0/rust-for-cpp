# Contributing and translating

The source of this book lives at
[github.com/xw0/rust-for-cpp](https://github.com/xw0/rust-for-cpp). Fixes,
new examples and translations are welcome as pull requests.

You do not need to write code to help:

- [Report a problem](https://github.com/xw0/rust-for-cpp/issues/new?template=correction.yml):
  a mistake, a confusing explanation, a broken example or a translation issue.
- [Request a topic](https://github.com/xw0/rust-for-cpp/issues/new?template=topic-request.yml):
  a C++ pattern you want translated, an engine subsystem, a crate.

For a small fix, the ✎ icon at the top of every page opens its source on
GitHub, where you can edit it and open a pull request from the browser.

## License

- Text and diagrams: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Code (examples, scripts, styles): [MIT](https://opensource.org/license/mit).

If you reuse or adapt material, credit it as:

> *Rust for C++ Programmers* (https://xw0.github.io/rust-for-cpp/), licensed
> under CC BY 4.0.

and say whether you changed it.

## How translations work

English Markdown under `src/` is the single source of truth. Each translation
is a [gettext](https://www.gnu.org/software/gettext/) catalog, `po/<lang>.po`,
that maps every English paragraph, heading, list item and table cell to its
translation. At build time the
[`mdbook-i18n-helpers`](https://github.com/google/mdbook-i18n-helpers)
preprocessor swaps the translated text in. Code blocks are shared, so examples
never drift between languages.

When an English paragraph changes, the old translation is marked *fuzzy* and
the English text is shown until a translator updates it. A translation can
therefore lag behind without ever breaking the build or showing outdated
content as if it were current.

Interactive diagrams are written in English in `theme/js/diagrams.js`. Their
strings are translated in `theme/js/i18n-<lang>.js`, a plain table from the
English string to the translation; missing entries fall back to English.

### Translating a chapter

```sh
# 1. Extract all English messages into po/messages.pot
MDBOOK_OUTPUT='{"xgettext": {"pot-file": "messages.pot"}}' mdbook build -d po

# 2. Create or update the catalog for your language
msginit -i po/messages.pot -l zh_CN -o po/zh-CN.po   # first time only
msgmerge --update po/zh-CN.po po/messages.pot        # afterwards

# 3. Edit po/zh-CN.po (Poedit, Lokalize, or any text editor), then preview
MDBOOK_BOOK__LANGUAGE=zh-CN mdbook serve -d book/zh-CN
```

## Building locally

```sh
cargo install mdbook --version "^0.4" --locked
cargo install mdbook-i18n-helpers --locked
mdbook serve --open     # English
mdbook test             # compile and run every Rust example
```

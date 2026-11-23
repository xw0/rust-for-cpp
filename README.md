# Rust for C++ Programmers

A free, open Rust tutorial for experienced C and C++ engineers, especially those
working on game engines and graphics. Every chapter starts from the C++ you
already know, explains ownership and borrowing with interactive stack/heap
diagrams, and runs its examples in the browser.

**Read it:** https://xw0.github.io/rust-for-cpp/ · 中文版：https://xw0.github.io/rust-for-cpp/zh-CN/

## Status

Complete in English and Chinese: three parts (the language, systems
programming, and engine and graphics work, including OpenGL, Vulkan, wgpu and
OpenXR) plus a cheat sheet. Every runnable example is compiled and tested on
each build. Feedback and corrections are welcome as issues or pull requests.

## Repository layout

```
book.toml               mdBook configuration
src/                    English Markdown: the single source of truth
  SUMMARY.md            table of contents
  foundations/          Part I: the language, from C++
  systems/              Part II: systems programming
  engine/               Part III: graphics and engine programming
po/<lang>.po            translations (gettext), e.g. po/zh-CN.po
theme/css/rfc.css       styles for callouts, comparisons and widgets
theme/js/memviz.js      step-through stack/heap diagram engine
theme/js/widgets.js     borrow timeline and arena playground widgets
theme/js/diagrams.js    the diagram data used by the chapters
theme/js/i18n*.js       string tables for translating the widgets
scripts/build.sh        build every language into book/
scripts/update-po.sh    refresh translation catalogs after English edits
```

## Build locally

```sh
cargo install mdbook --version 0.4.52 --locked
cargo install mdbook-i18n-helpers --version 0.3.6 --locked
mdbook serve --open   # English, live reload
mdbook test           # compile and run every Rust example
scripts/build.sh      # all languages into book/
```

## How multiple languages work

English is written first, and translations follow. The structure supports any
number of languages from day one:

- Prose is translated with gettext catalogs (`po/<lang>.po`) through
  [mdbook-i18n-helpers](https://github.com/google/mdbook-i18n-helpers), the
  same system Google's Comprehensive Rust uses for its translations.
- Code blocks are shared between languages, so examples cannot drift.
- When English text changes, the translated entry becomes *fuzzy* and the page
  shows English for that paragraph until a translator updates it. Translations
  can lag without breaking.
- Interactive diagrams are data in `theme/js/diagrams.js`; their strings are
  translated through `theme/js/i18n-<lang>.js`.
- Each language is built into its own folder (`/`, `/zh-CN/`) with a switcher
  in the top bar that keeps you on the same page.

See [Contributing and translating](src/appendix/contributing.md).

## Feedback and contributions

Found a mistake, an unclear explanation or a broken example?
[Report a problem](https://github.com/xw0/rust-for-cpp/issues/new?template=correction.yml).
Want a topic covered?
[Request a topic](https://github.com/xw0/rust-for-cpp/issues/new?template=topic-request.yml).
Pull requests are welcome too, for both English and translations.

## Author

Written by Xiang Wei. More projects: [portfolio](https://xw0.github.io/portfolio.html).

## License

Text and diagrams: [CC BY 4.0](LICENSE-CC-BY-4.0). Code: [MIT](LICENSE-MIT).
See [LICENSE.md](LICENSE.md) for how to credit the book.

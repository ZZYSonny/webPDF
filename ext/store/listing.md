# Chrome Web Store listing

Everything the store asks for, ready to paste. The package is
`dist/ext/webpdf-0.1.0.zip`; this directory is the listing around it: the icon,
the screenshots, the two promotional tiles, and the words.

The store item is **webPDF**, id `mfbmigolccdnfnklinknapcnoigdbefk` (the store
assigns this id; it is not the id of a self-hosted crx).

## Product details

| Field | Value |
| --- | --- |
| Title (from the package) | `webPDF` |
| Summary (from the package) | `Read PDFs in the browser as SVG pages with real, selectable text.` |
| Category | **Productivity** (效率) |
| Language | **English (United States)** — add a Chinese translation from the text below if wanted |
| Official URL | leave empty — this needs Search Console verification of the site, and `github.io` is not a domain you can verify |
| Homepage URL | `https://zzysonny.github.io/webPDF/` |
| Support URL | `https://github.com/ZZYSonny/webPDF/issues` |
| Adult content | **No** |
| Visibility | **Public** |
| Product support | on — the support URL above |

### Description (English)

```
webPDF opens PDFs in Chrome as pages you can read, search and copy — not as a picture of a page.

Every page is drawn as SVG, and the document's own fonts are rebuilt for the browser. The words on screen are real text: select a sentence, search the document, copy a quote, or let a screen reader follow along, while the page keeps the typeface, the spacing and the figures it was printed with.

• Real text — select, search and copy. Every match is boxed, and the viewer has its own find.
• The document's fonts — embedded Type 1, TrueType and CFF faces are rebuilt, not replaced by a lookalike.
• Faithful pages — figures, tables, rules and margins stay where the PDF put them.
• A quiet reader — one bar, zoom, page numbers, an outline when the document has one, and the keyboard you already use.
• Nothing uploaded — the PDF is fetched from the site you opened and rendered on your machine. No account, no analytics, and no server of ours ever sees the document.

Open a PDF link and webPDF takes the tab. The document you were reading is one click away on the toolbar. Built on MuPDF: a Rust core compiled to WebAssembly, with an open-source viewer.
```

### 说明（中文翻译，可选）

If you add a Chinese listing, use this as its description.

```
webPDF 让 Chrome 里的 PDF 变成真正可读、可搜索、可复制的页面，而不是一张页面截图。

每一页都渲染为 SVG，文档自带的字体会为浏览器重新构建。屏幕上的文字就是文本：选中一句话、搜索全文、复制引用，或者让读屏软件朗读，同时保留原稿的字体、字距与插图。

• 真实文本：可选中、可搜索、可复制，匹配处逐一处高亮，查看器自带查找。
• 保留原字体：内嵌的 Type 1、TrueType 与 CFF 字体会被重建，而不是替换成相似的字体。
• 版式忠实：图表、表格、线条与页边距都留在 PDF 放置它们的位置。
• 安静的阅读器：只有一条工具栏、缩放、页码，有目录时显示目录，快捷键与浏览器一致。
• 不上传文件：PDF 从你打开的站点读取，并在本机渲染。没有账号，没有统计，我们的服务器不会看到文档。

打开 PDF 链接，webPDF 会接管标签页；工具栏一键回到上次阅读的文档。基于 MuPDF，核心由 Rust 编译为 WebAssembly，查看器开源。
```

## Images

| Slot | File | Size | Notes |
| --- | --- | --- | --- |
| Store icon | `icon-128.png` | 128×128 | from `demo/icon.png` |
| Screenshot 1 | `screenshot-1-reading.png` | 1280×800 | the paper, with the find box and every match boxed |
| Screenshot 2 | `screenshot-2-select.png` | 1280×800 | a line selected as real text, next to Figure 3 |
| Screenshot 3 | `screenshot-3-table.png` | 1280×800 | a results page: Table 6, as text |
| Small promo tile | `promo-440x280.png` | 440×280 | |
| Marquee promo tile | `promo-1400x560.png` | 1400×560 | |

All of them are 24-bit PNG with no alpha, which is what the store requires.
Screenshots are of *Deep Residual Learning for Image Recognition*
(arXiv:1512.03385v1), rendered by the real viewer at 1280×800.

To rebuild them:

```
npm run preview -- --port 5190          # in one terminal, with .scratch/pdfs filled
node ext/store/shoot.ts                 # 1280×800 screenshots into .scratch/store-raw
python3 ext/store/assets.py             # icon, flattened screenshots, promo tiles
```

## Privacy tab

**Single purpose**

```
Read PDFs in the browser as SVG pages with real, selectable text.
```

**Permission justification**

| Permission | Why it is needed |
| --- | --- |
| `storage` | Keeps one random handover token and the address and title of the last PDF, locally, so the toolbar button can reopen that document and a redirect still works after the service worker is stopped. Nothing in it leaves the browser. |
| `declarativeNetRequestWithHostAccess` | Installs one dynamic rule: a URL whose path ends in `.pdf` is redirected to the extension's viewer page before the document is requested. |
| `webRequest` | Reads response headers only, so a PDF served from a URL without a `.pdf` ending (for example `arxiv.org/pdf/1706.03762v7`) is recognised by its content type and opened in the viewer. |
| `webNavigation` | Notices a tab that has committed to a PDF (a local file, or a URL the redirect rule could not take) and hands that tab to the viewer. |
| Host permission `<all_urls>` | PDFs can be hosted anywhere. When the reader opens one, the extension page fetches that one document from the site they chose, so the viewer can draw it; there is no proxy and nothing is sent anywhere else. The extension does not read pages that are not PDFs. |

**Remote code**

```
No. The extension's own scripts are bundled in the package, and its extension
pages load only local files (the manifest's CSP is script-src 'self'). The
reading surface is the project's public web page,
https://zzysonny.github.io/webPDF/, displayed in an iframe — the same page
anyone can open in a tab, with no extension APIs.
```

**Data usage**

Select **does not collect user data**. If the form asks what is handled, the
honest answer is: PDFs and their URLs are processed locally to draw the document;
the last PDF's URL and title are stored locally; nothing is transmitted to the
developer.

**Privacy policy URL**

```
https://github.com/ZZYSonny/webPDF/blob/main/PRIVACY.md
```

The text is in [`PRIVACY.md`](../../PRIVACY.md); push it before submitting so the
URL resolves.

## Distribution

- Public, all regions unless there is a reason to exclude one.
- The extension needs `minimum_chrome_version` 115, which the manifest declares.
- No in-app purchases, no payments.

## Before uploading

```
npm run build:extension
```

writes `dist/ext/webpdf/` and `dist/ext/webpdf-0.1.0.zip`. Upload the **zip**,
never a `.crx`; the package deliberately has no manifest `key`, because the store
assigns the id itself. If the store says version `0.1.0` already exists, raise
`version` in `package.json`, rebuild, and upload the new zip.

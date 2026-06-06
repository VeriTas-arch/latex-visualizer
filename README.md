# LaTeX Visualizer

A lightweight VS Code preview for LaTeX prose and formulas. It renders the active `.tex` file in a side preview without requiring a TeX installation, using KaTeX for math and simple HTML approximations for common document structures.

## Features

- Open a live preview from the editor title button or the `Open LaTeX Preview` command.
- Render inline math, display math, and common math environments with KaTeX.
- Show readable previews for headings, paragraphs, figures, tables, and algorithm blocks.
- Use image placeholders that preserve declared `width` / `height` information.
- Double-click preview content to jump back to the corresponding source line, with word-level targeting for text where possible.
- Zoom preview content with `Ctrl` + mouse wheel.
- Keep rendering local to the current file; malformed formulas show local KaTeX errors instead of breaking the whole preview.

## Requirements

No TeX distribution is required. The extension uses bundled JavaScript dependencies.

## Settings

- `latexVisualizer.previewFontSize`: base preview font size in pixels.
- `latexVisualizer.previewZoom.default`: default preview zoom percentage.
- `latexVisualizer.previewZoom.min`: minimum preview zoom percentage.
- `latexVisualizer.previewZoom.max`: maximum preview zoom percentage.
- `latexVisualizer.previewZoom.step`: zoom step used by `Ctrl` + mouse wheel.

## Known Limitations

- This is an approximate preview, not a TeX compiler.
- Layout details such as page breaks, floats, and package-specific formatting are not reproduced.
- Cross-file projects, bibliography resolution, and full macro expansion are not implemented.
- TikZ and PDF generation are intentionally out of scope for the current release.

## Development

```bash
npm install
npm run compile
npm run lint
npm run sample
```

`npm run sample` checks the formula renderer against the local `samples/*.tex` fixtures.

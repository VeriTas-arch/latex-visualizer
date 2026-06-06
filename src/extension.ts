import * as vscode from 'vscode';
import { clearTimeout, setTimeout } from 'node:timers';

const commandId = 'latex-visualizer.openPreview';

export function activate(context: vscode.ExtensionContext) {
    const preview = new LatexPreview(context.extensionUri);

    context.subscriptions.push(
        vscode.commands.registerCommand(commandId, () => preview.open()),
        vscode.workspace.onDidChangeTextDocument((event) => preview.onDocumentChange(event.document)),
        vscode.window.onDidChangeActiveTextEditor((editor) => preview.onActiveEditorChange(editor)),
        vscode.workspace.onDidChangeConfiguration((event) => preview.onConfigurationChange(event))
    );
}

export function deactivate() { }

class LatexPreview {
    private panel: vscode.WebviewPanel | undefined;
    private document: vscode.TextDocument | undefined;
    private debounce: ReturnType<typeof setTimeout> | undefined;
    private webviewReady = false;
    private lastSentUri: string | undefined;
    private lastSentVersion: number | undefined;
    private sourceViewColumn: vscode.ViewColumn | undefined;

    constructor(private readonly extensionUri: vscode.Uri) { }

    open() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showInformationMessage('Open a LaTeX file before opening the preview.');
            return;
        }

        this.document = editor.document;
        this.sourceViewColumn = editor.viewColumn;

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            this.postRender();
            return;
        }

        this.webviewReady = false;
        this.panel = vscode.window.createWebviewPanel(
            'latexVisualizerPreview',
            `LaTeX Preview: ${editor.document.fileName.split(/[\\/]/).pop() ?? 'Untitled'}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist')
                ]
            }
        );
        this.panel.webview.onDidReceiveMessage((message) => {
            if (message?.type === 'ready') {
                this.webviewReady = true;
                this.postSettings();
                this.postRender(true);
            } else if (message?.type === 'jumpToLine' && typeof message.line === 'number') {
                void this.jumpToLine(message.line, typeof message.selectedText === 'string' ? message.selectedText : '');
            }
        });
        this.panel.webview.html = this.html(this.panel.webview);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.document = undefined;
            this.webviewReady = false;
            this.lastSentUri = undefined;
            this.lastSentVersion = undefined;
            this.clearDebounce();
        });
    }

    onDocumentChange(document: vscode.TextDocument) {
        if (!this.panel || !this.document || document.uri.toString() !== this.document.uri.toString()) {
            return;
        }

        this.clearDebounce();
        this.debounce = setTimeout(() => this.postRender(), 250);
    }

    onActiveEditorChange(editor: vscode.TextEditor | undefined) {
        if (!this.panel || !editor || editor.document.languageId !== 'latex') {
            return;
        }

        this.document = editor.document;
        this.sourceViewColumn = editor.viewColumn;
        this.panel.title = `LaTeX Preview: ${editor.document.fileName.split(/[\\/]/).pop() ?? 'Untitled'}`;
        this.postRender();
    }

    onConfigurationChange(event: vscode.ConfigurationChangeEvent) {
        if (event.affectsConfiguration('latexVisualizer.previewZoom') || event.affectsConfiguration('latexVisualizer.previewFontSize')) {
            this.postSettings();
        }
    }

    private postRender(force = false) {
        if (!this.panel || !this.document || !this.webviewReady) {
            return;
        }

        const uri = this.document.uri.toString();
        if (!force && this.lastSentUri === uri && this.lastSentVersion === this.document.version) {
            return;
        }

        this.lastSentUri = uri;
        this.lastSentVersion = this.document.version;
        void this.panel.webview.postMessage({
            type: 'render',
            fileName: this.document.fileName,
            source: this.document.getText()
        });
    }

    private postSettings() {
        if (!this.panel || !this.webviewReady) {
            return;
        }

        void this.panel.webview.postMessage({
            type: 'settings',
            zoom: getPreviewZoomSettings()
        });
    }

    private clearDebounce() {
        if (this.debounce) {
            clearTimeout(this.debounce);
            this.debounce = undefined;
        }
    }

    private async jumpToLine(line: number, selectedText: string) {
        if (!this.document) {
            return;
        }

        const target = this.findJumpTarget(line, selectedText);
        const editor = await vscode.window.showTextDocument(this.document, {
            viewColumn: this.sourceViewColumn ?? vscode.ViewColumn.One,
            preserveFocus: false
        });
        const position = new vscode.Position(target.line, target.character);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private findJumpTarget(line: number, selectedText: string) {
        if (!this.document) {
            return { line: 0, character: 0 };
        }

        const fallbackLine = Math.max(0, Math.min(this.document.lineCount - 1, Math.floor(line) - 1));
        const needle = normalizeSelectedText(selectedText);
        if (!needle) {
            return { line: fallbackLine, character: 0 };
        }

        const searchStart = Math.max(0, fallbackLine - 1);
        const searchEnd = Math.min(this.document.lineCount - 1, fallbackLine + 8);
        for (let lineIndex = searchStart; lineIndex <= searchEnd; lineIndex++) {
            const character = this.document.lineAt(lineIndex).text.indexOf(needle);
            if (character !== -1) {
                return { line: lineIndex, character };
            }
        }

        return { line: fallbackLine, character: 0 };
    }

    private html(webview: vscode.Webview) {
        const nonce = getNonce();
        const katexCss = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css'));
        const katexJs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link nonce="${nonce}" rel="stylesheet" href="${katexCss}">
	<style nonce="${nonce}">
		:root {
			color-scheme: light dark;
			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--muted: var(--vscode-descriptionForeground);
			--border: var(--vscode-panel-border);
			--code: var(--vscode-textCodeBlock-background);
			--error-bg: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 55%, transparent);
			--error-border: var(--vscode-inputValidation-errorBorder);
		}

		body {
			margin: 0;
			background: var(--bg);
			color: var(--fg);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			line-height: 1.65;
		}

		.toolbar {
			position: sticky;
			top: 0;
			z-index: 2;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 8px 16px;
			border-bottom: 1px solid var(--border);
			background: var(--bg);
		}

		.file {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
		}

		.toolbar-actions {
			display: flex;
			align-items: center;
			gap: 8px;
			flex: 0 0 auto;
		}

		.zoom-readout {
			min-width: 42px;
			color: var(--muted);
			font-variant-numeric: tabular-nums;
			text-align: right;
		}

		button {
			color: var(--fg);
			background: var(--vscode-button-secondaryBackground);
			border: 1px solid var(--border);
			border-radius: 4px;
			padding: 4px 10px;
			cursor: pointer;
		}

		button:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		main {
			box-sizing: border-box;
			max-width: 920px;
			margin: 0 auto;
			padding: 20px 24px 48px;
		}

		h1, h2, h3, h4 {
			line-height: 1.3;
			margin: 1.4em 0 0.55em;
		}

		p {
			margin: 0.7em 0;
		}

		[data-source-line] {
			cursor: default;
		}

		.math-block {
			overflow-x: auto;
			margin: 1em 0;
			padding: 10px 0;
		}

		.math-inline {
			padding: 0 1px;
		}

		.latex-ref {
			display: inline-block;
			max-width: 28em;
			margin: 0 2px;
			padding: 0 5px;
			border: 1px solid var(--border);
			border-radius: 4px;
			background: var(--code);
			color: var(--fg);
			font-family: var(--vscode-editor-font-family);
			font-size: 0.88em;
			line-height: 1.45;
			vertical-align: baseline;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.latex-ref-cite {
			color: var(--vscode-textLink-foreground);
		}

		.latex-ref-label {
			color: var(--muted);
		}

		.render-error {
			border-left: 3px solid var(--error-border);
			background: var(--error-bg);
			padding: 8px 10px;
			overflow-x: auto;
		}

		.render-error code,
		pre {
			font-family: var(--vscode-editor-font-family);
			background: var(--code);
		}

		pre {
			padding: 8px;
			overflow-x: auto;
		}

		.placeholder {
			color: var(--muted);
			font-style: italic;
		}

		.figure-placeholder {
			margin: 1.1em 0;
			padding: 12px;
			border: 1px dashed var(--border);
			background: var(--code);
		}

		.image-box {
			box-sizing: border-box;
			min-height: 96px;
			display: flex;
			align-items: center;
			justify-content: center;
			margin: 0 auto;
			padding: 12px;
			border: 1px solid var(--border);
			color: var(--muted);
			text-align: center;
		}

		.caption {
			margin-top: 8px;
			color: var(--muted);
			font-style: italic;
		}

		.algorithm-wrap {
			margin: 1em 0;
			padding: 10px 12px;
			border: 1px solid var(--border);
			background: var(--code);
		}

		.algorithm-title {
			margin-bottom: 8px;
			font-weight: 600;
		}

		.algorithm-steps {
			margin: 0;
			padding-left: 22px;
		}

		.algorithm-steps li {
			margin: 4px 0;
		}

		.algorithm-keyword {
			margin-right: 6px;
			color: var(--muted);
			font-weight: 600;
		}

		.table-wrap {
			overflow-x: auto;
			margin: 1em 0;
		}

		table {
			border-collapse: collapse;
			width: 100%;
			font-size: 0.95em;
		}

		th,
		td {
			border: 1px solid var(--border);
			padding: 6px 8px;
			vertical-align: top;
		}

		th {
			font-weight: 600;
			background: var(--code);
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<div class="file" id="file">No document</div>
		<div class="toolbar-actions">
			<span class="zoom-readout" id="zoom">100%</span>
			<button id="refresh" type="button">Refresh</button>
		</div>
	</div>
	<main id="preview"></main>
	<script nonce="${nonce}" src="${katexJs}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const preview = document.getElementById('preview');
		const file = document.getElementById('file');
		const zoom = document.getElementById('zoom');
		let currentSource = '';
		let zoomSettings = { default: 100, min: 20, max: 300, step: 10, fontSize: 14 };
		let zoomPercent = clampZoom(vscode.getState()?.zoomPercent ?? zoomSettings.default);

		vscode.postMessage({ type: 'ready' });
		applyZoom();

		document.getElementById('refresh').addEventListener('click', () => render(currentSource));
		preview.addEventListener('wheel', (event) => {
			if (!event.ctrlKey) {
				return;
			}

			event.preventDefault();
			setZoom(zoomPercent + (event.deltaY < 0 ? zoomSettings.step : -zoomSettings.step));
		}, { passive: false });

		preview.addEventListener('dblclick', (event) => {
			const target = event.target instanceof Element ? event.target.closest('[data-source-line]') : undefined;
			if (!target) {
				return;
			}

			const line = Number(target.dataset.sourceLine);
			if (Number.isFinite(line)) {
				const selection = window.getSelection();
				const selectedText = selection ? selection.toString() : '';
				vscode.postMessage({ type: 'jumpToLine', line, selectedText });
				if (selection) {
					selection.removeAllRanges();
				}
			}
		});

		window.addEventListener('message', (event) => {
			if (event.data.type === 'settings') {
				zoomSettings = normalizeZoomSettings(event.data.zoom);
				setZoom(zoomPercent);
				return;
			}

			if (event.data.type !== 'render') {
				return;
			}

			currentSource = event.data.source;
			file.textContent = event.data.fileName;
			render(currentSource);
		});

		function render(source) {
			preview.replaceChildren(...renderParts(scanMath(source)));
		}

		function setZoom(value) {
			zoomPercent = clampZoom(value);
			applyZoom();
			vscode.setState({ ...(vscode.getState() || {}), zoomPercent });
		}

		function applyZoom() {
			preview.style.fontSize = (zoomSettings.fontSize * zoomPercent / 100) + 'px';
			zoom.textContent = Math.round(zoomPercent) + '%';
		}

		function normalizeZoomSettings(settings) {
			const min = finiteNumber(settings?.min, 20);
			const max = Math.max(min, finiteNumber(settings?.max, 300));
			return {
				default: clamp(finiteNumber(settings?.default, 100), min, max),
				min,
				max,
				step: Math.max(1, finiteNumber(settings?.step, 10)),
				fontSize: clamp(finiteNumber(settings?.fontSize, 14), 8, 48)
			};
		}

		function clampZoom(value) {
			return clamp(finiteNumber(value, zoomSettings.default), zoomSettings.min, zoomSettings.max);
		}

		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		function finiteNumber(value, fallback) {
			return Number.isFinite(Number(value)) ? Number(value) : fallback;
		}

		function renderParts(parts) {
			const nodes = [];
			let paragraph;

			function ensureParagraph(line) {
				if (!paragraph) {
					paragraph = document.createElement('p');
					setSourceLine(paragraph, line);
				}
				return paragraph;
			}

			function flushParagraph() {
				if (paragraph && paragraph.textContent.trim()) {
					nodes.push(paragraph);
				}
				paragraph = undefined;
			}

			for (const part of parts) {
				if (part.type === 'text') {
					appendText(part.value, part.line, ensureParagraph, flushParagraph, nodes);
				} else if (part.type === 'math') {
					if (part.display) {
						flushParagraph();
						nodes.push(withSourceLine(renderMath(part.value, part.display, part.env), part.line));
					} else {
						ensureParagraph(part.line).append(withSourceLine(renderMath(part.value, part.display, part.env), part.line));
					}
				} else if (part.type === 'block') {
					flushParagraph();
					nodes.push(withSourceLine(renderBlock(part), part.line));
				}
			}

			flushParagraph();
			return nodes.length ? nodes : [element('p', 'placeholder', 'Empty document')];
		}

		function appendText(text, startLine, ensureParagraph, flushParagraph, nodes) {
			const lines = text.replace(/\\r/g, '').split('\\n');
			let sourceLine = startLine;

			for (const line of lines) {
				if (!line.trim()) {
					flushParagraph();
					sourceLine++;
					continue;
				}

				const heading = line.trim().match(/^\\\\(chapter|section|subsection|subsubsection|paragraph)\\*?\\{([\\s\\S]*)\\}$/);
				if (heading) {
					flushParagraph();
					const level = { chapter: 'h1', section: 'h2', subsection: 'h3', subsubsection: 'h4', paragraph: 'h4' }[heading[1]];
					const node = document.createElement(level);
					setSourceLine(node, sourceLine);
					appendInlineLatex(node, heading[2]);
					nodes.push(node);
					sourceLine++;
					continue;
				}

				const lineSpan = element('span', '', '');
				setSourceLine(lineSpan, sourceLine);
				appendInlineLatex(lineSpan, line + ' ');
				ensureParagraph(sourceLine).append(lineSpan);
				sourceLine++;
			}
		}

		function renderBlock(part) {
			if (part.env === 'figure') {
				return renderFigure(part.value);
			}

			if (part.env === 'table' || part.env === 'tabular') {
				return renderTable(part.value);
			}

			if (part.env === 'algorithm') {
				return renderAlgorithm(part.value);
			}

			const pre = document.createElement('pre');
			pre.textContent = cleanInlineText(part.value);
			return pre;
		}

		function renderAlgorithm(source) {
			const wrapper = document.createElement('div');
			wrapper.className = 'algorithm-wrap';

			const captionText = readCommandArgument(source, 'caption');
			if (captionText) {
				const title = element('div', 'algorithm-title', '');
				appendInlineLatex(title, captionText);
				wrapper.append(title);
			}

			const algorithmic = source.match(/\\\\begin\\{algorithmic\\}([\\s\\S]*?)\\\\end\\{algorithmic\\}/);
			if (!algorithmic) {
				const fallback = document.createElement('p');
				appendInlineLatex(fallback, cleanInlineText(source));
				wrapper.append(fallback);
				return wrapper;
			}

			const list = document.createElement('ol');
			list.className = 'algorithm-steps';
			for (const rawLine of algorithmic[1].split('\\n')) {
				const parsed = parseAlgorithmLine(rawLine);
				if (!parsed) {
					continue;
				}

				const item = document.createElement('li');
				if (parsed.keyword) {
					item.append(element('span', 'algorithm-keyword', parsed.keyword));
				}
				appendInlineLatex(item, parsed.text);
				list.append(item);
			}

			wrapper.append(list);
			return wrapper;
		}

		function parseAlgorithmLine(line) {
			const trimmed = line.trim();
			if (!trimmed) {
				return undefined;
			}

			const command = trimmed.match(/^\\\\(REQUIRE|ENSURE|STATE)\\s+([\\s\\S]*)$/);
			if (command) {
				const labels = { REQUIRE: 'Require', ENSURE: 'Ensure', STATE: '' };
				return { keyword: labels[command[1]], text: command[2] };
			}

			const loop = trimmed.match(/^\\\\FOR\\{([\\s\\S]*)\\}$/);
			if (loop) {
				return { keyword: 'For', text: loop[1] };
			}

			if (/^\\\\ENDFOR\\b/.test(trimmed)) {
				return { keyword: 'EndFor', text: '' };
			}

			return { keyword: '', text: trimmed };
		}

		function renderFigure(source) {
			const figure = document.createElement('figure');
			figure.className = 'figure-placeholder';
			const images = [...source.matchAll(/\\\\includegraphics(?:\\[([^\\]]*)\\])?\\{([^}]*)\\}/g)];

			if (images.length === 0) {
				figure.append(element('div', 'image-box', 'Figure placeholder'));
			}

			for (const image of images) {
				const info = parseImageOptions(image[1] ?? '');
				const box = element('div', 'image-box', image[2] + formatImageInfo(info));
				if (info.widthPercent) {
					box.style.width = info.widthPercent + '%';
				}
				figure.append(box);
			}

			const captionText = readCommandArgument(source, 'caption');
			if (captionText) {
				const caption = element('figcaption', 'caption', '');
				appendInlineLatex(caption, captionText);
				figure.append(caption);
			}

			return figure;
		}

		function renderTable(source) {
			const tableSource = source.match(/\\\\begin\\{tabular\\}\\{[^}]*\\}([\\s\\S]*?)\\\\end\\{tabular\\}/);
			if (!tableSource) {
				return element('p', 'placeholder', cleanInlineText(readCommandArgument(source, 'caption') || '[table]'));
			}

			const wrapper = document.createElement('div');
			wrapper.className = 'table-wrap';
			const table = document.createElement('table');
			const tbody = document.createElement('tbody');
			const rows = tableSource[1]
				.replace(/\\\\(toprule|midrule|bottomrule|hline)\\b/g, '')
				.split(/\\\\\\\\(?:\\s*\\[[^\\]]*\\])?/g)
				.map((row) => row.trim())
				.filter((row) => row && !/^\\\\+$/.test(row));

			for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
				const row = document.createElement('tr');
				const cells = rows[rowIndex].split(/(?<!\\\\)&/g);
				for (const cell of cells) {
					const node = document.createElement(rowIndex === 0 ? 'th' : 'td');
					appendInlineLatex(node, cell.trim());
					row.append(node);
				}
				tbody.append(row);
			}

			table.append(tbody);
			wrapper.append(table);

			const captionText = readCommandArgument(source, 'caption');
			if (captionText) {
				const caption = element('div', 'caption', '');
				appendInlineLatex(caption, captionText);
				wrapper.append(caption);
			}

			return wrapper;
		}

		function appendInlineLatex(container, source) {
			for (const part of scanMath(source)) {
				if (part.type === 'text') {
					const html = inlineMarkup(part.value);
					if (html) {
						container.insertAdjacentHTML('beforeend', html);
					}
				} else if (part.type === 'math') {
					container.append(renderMath(part.value, false, part.env));
				}
			}
		}

		function renderMath(source, display, env) {
			const container = document.createElement(display ? 'div' : 'span');
			container.className = display ? 'math-block' : 'math-inline';

			const mathSource = normalizeMath(source, env);
			try {
				katex.render(mathSource, container, {
					displayMode: display,
					throwOnError: true,
					strict: false,
					trust: false,
					macros: {
						'\\\\ang': '#1^\\\\circ',
						'\\\\bm': '\\\\boldsymbol{#1}',
						'\\\\SI': '#1\\\\,\\\\mathrm{#2}',
						'\\\\SIrange': '#1--#2\\\\,\\\\mathrm{#3}'
					}
				});
			} catch (error) {
				container.className = 'render-error';
				const message = error && error.message ? error.message : String(error);
				container.append(
					element('div', '', 'KaTeX error: ' + message),
					element('pre', '', mathSource)
				);
			}

			return container;
		}

		function scanMath(source) {
			const parts = [];
			let textStart = 0;
			let i = 0;

			while (i < source.length) {
				if (source[i] === '%') {
					i = skipComment(source, i);
					continue;
				}

				const block = blockEnvAt(source, i);
				if (block) {
					const endToken = '\\\\end{' + block.name + '}';
					const contentStart = i + block.open.length;
					const end = source.indexOf(endToken, contentStart);
					if (end !== -1) {
						pushText(parts, source.slice(textStart, i), lineAt(source, textStart));
						parts.push({ type: 'block', value: source.slice(i, end + endToken.length), env: block.base, line: lineAt(source, i) });
						i = end + endToken.length;
						textStart = i;
						continue;
					}
				}

				if (source.startsWith('\\\\[', i)) {
					i = pushDelimited(parts, source, textStart, i, i + 2, '\\\\]', true);
					textStart = i;
					continue;
				}

				if (source.startsWith('\\\\(', i)) {
					i = pushDelimited(parts, source, textStart, i, i + 2, '\\\\)', false);
					textStart = i;
					continue;
				}

				if (source.startsWith('$$', i)) {
					i = pushDelimited(parts, source, textStart, i, i + 2, '$$', true);
					textStart = i;
					continue;
				}

				const env = displayEnvAt(source, i);
				if (env) {
					const endToken = '\\\\end{' + env.name + '}';
					const contentStart = i + env.open.length;
					const end = source.indexOf(endToken, contentStart);
					if (end !== -1) {
						pushText(parts, source.slice(textStart, i), lineAt(source, textStart));
						parts.push({ type: 'math', value: source.slice(contentStart, end), display: true, env: env.base, line: lineAt(source, i) });
						i = end + endToken.length;
						textStart = i;
						continue;
					}
				}

				if (source[i] === '$' && source[i - 1] !== '\\\\' && source[i + 1] !== '$') {
					i = pushDollar(parts, source, textStart, i);
					textStart = i;
					continue;
				}

				i++;
			}

			pushText(parts, source.slice(textStart), lineAt(source, textStart));
			return parts;
		}

		function pushDelimited(parts, source, textStart, start, contentStart, close, display) {
			const end = source.indexOf(close, contentStart);
			if (end === -1) {
				return start + 1;
			}
			pushText(parts, source.slice(textStart, start), lineAt(source, textStart));
			parts.push({ type: 'math', value: source.slice(contentStart, end), display, env: '', line: lineAt(source, start) });
			return end + close.length;
		}

		function pushDollar(parts, source, textStart, start) {
			let i = start + 1;
			while (i < source.length) {
				if (source[i] === '%' && source[i - 1] !== '\\\\') {
					i = skipComment(source, i);
					continue;
				}
				if (source[i] === '$' && source[i - 1] !== '\\\\') {
					pushText(parts, source.slice(textStart, start), lineAt(source, textStart));
					parts.push({ type: 'math', value: source.slice(start + 1, i), display: false, env: '', line: lineAt(source, start) });
					return i + 1;
				}
				i++;
			}
			return start + 1;
		}

		function displayEnvAt(source, index) {
			const match = source.slice(index).match(/^\\\\begin\\{(equation\\*?|align\\*?|gather\\*?|multline\\*?|flalign\\*?|alignat\\*?)\\}/);
			if (!match) {
				return undefined;
			}
			return { name: match[1], base: match[1].replace('*', ''), open: match[0] };
		}

		function blockEnvAt(source, index) {
			const match = source.slice(index).match(/^\\\\begin\\{(figure\\*?|table\\*?|algorithm\\*?|tabular)\\}(?:\\{[^}]*\\})?/);
			if (!match) {
				return undefined;
			}
			return { name: match[1], base: match[1].replace('*', ''), open: match[0] };
		}

		function skipComment(source, index) {
			const nextLine = source.indexOf('\\n', index);
			return nextLine === -1 ? source.length : nextLine + 1;
		}

		function pushText(parts, value, line) {
			if (value) {
				parts.push({ type: 'text', value, line });
			}
		}

		function lineAt(source, index) {
			let line = 1;
			for (let i = 0; i < index; i++) {
				if (source[i] === '\\n') {
					line++;
				}
			}
			return line;
		}

		function withSourceLine(node, line) {
			setSourceLine(node, line);
			return node;
		}

		function setSourceLine(node, line) {
			if (Number.isFinite(line)) {
				node.dataset.sourceLine = String(line);
			}
		}

		function normalizeMath(source, env) {
			let normalized = source
				.replace(/\\\\label\\{[^}]*\\}/g, '')
				.replace(/\\\\nonumber\\b/g, '')
				.replace(/\\\\notag\\b/g, '')
				.trim();

			if (env === 'align' || env === 'flalign' || env === 'alignat') {
				normalized = '\\\\begin{aligned}' + normalized + '\\\\end{aligned}';
			} else if (env === 'gather') {
				normalized = '\\\\begin{gathered}' + normalized + '\\\\end{gathered}';
			} else if (env === 'multline') {
				normalized = '\\\\begin{aligned}' + normalized + '\\\\end{aligned}';
			}

			return normalized;
		}

		function readCommandArgument(source, command) {
			const start = source.indexOf('\\\\' + command + '{');
			if (start === -1) {
				return '';
			}

			let depth = 0;
			const contentStart = start + command.length + 2;
			for (let i = contentStart; i < source.length; i++) {
				if (source[i] === '{') {
					depth++;
				} else if (source[i] === '}') {
					if (depth === 0) {
						return source.slice(contentStart, i);
					}
					depth--;
				}
			}

			return '';
		}

		function parseImageOptions(options) {
			const width = options.match(/width\\s*=\\s*([^,\\]]+)/);
			const height = options.match(/height\\s*=\\s*([^,\\]]+)/);
			const widthPercent = width ? lengthToPercent(width[1]) : undefined;
			return {
				width: width ? width[1].trim() : '',
				height: height ? height[1].trim() : '',
				widthPercent
			};
		}

		function lengthToPercent(value) {
			const normalized = value.replace(/\\s/g, '');
			if (normalized === '\\\\linewidth' || normalized === '\\\\textwidth') {
				return 100;
			}

			const fraction = normalized.match(/^(0?\\.\\d+|\\d+(?:\\.\\d+)?)\\\\(?:line|text)width$/);
			if (fraction) {
				return Math.max(10, Math.min(100, Number(fraction[1]) * 100));
			}

			return undefined;
		}

		function formatImageInfo(info) {
			const details = [];
			if (info.width) {
				details.push('width=' + info.width);
			}
			if (info.height) {
				details.push('height=' + info.height);
			}
			return details.length ? ' (' + details.join(', ') + ')' : '';
		}

		function cleanInlineText(text, trim = true) {
			let value = text
				.replace(/%.*$/gm, '')
				.replace(/\\\\label\\{[^}]*\\}/g, '')
				.replace(/\\\\(cite|citet|citep|ref|eqref|autoref|cref)\\{([^}]*)\\}/g, '$2')
				.replace(/\\\\SIrange\\{([^}]*)\\}\\{([^}]*)\\}\\{([^}]*)\\}/g, '$1-$2 $3')
				.replace(/\\\\SI\\{([^}]*)\\}\\{([^}]*)\\}/g, '$1 $2')
				.replace(/\\\\si\\{([^}]*)\\}/g, '$1')
				.replace(/\\\\ang\\{([^}]*)\\}/g, '$1 deg')
				.replace(/\\\\includegraphics(?:\\[[^\\]]*\\])?\\{[^}]*\\}/g, '[image]')
				.replace(/\\\\(centering|small|footnotesize|normalsize)\\b/g, '')
				.replace(/\\\\begin\\{[^}]*\\}|\\\\end\\{[^}]*\\}/g, '')
				.replace(/\\\\(textbf|textit|emph|texttt|textsc)\\{([^{}]*)\\}/g, '$2')
				.replace(/\\\\%/g, '%')
				.replace(/\\\\&/g, '&')
				.replace(/\\\\[a-zA-Z]+\\*?(?:\\[[^\\]]*\\])?/g, '')
				.replace(/[{}]/g, '')
				.replace(/~+/g, ' ')
				.replace(/\\s+/g, ' ');

			return trim ? value.trim() : value;
		}

		function inlineMarkup(text) {
			const tokens = [];
			let value = text
				.replace(/\\\\(cite|citet|citep)\\{([^}]*)\\}/g, (_, command, key) => protectReference(tokens, command, key, 'latex-ref-cite'))
				.replace(/\\\\(ref|eqref|autoref|cref)\\{([^}]*)\\}/g, (_, command, key) => protectReference(tokens, command, key, 'latex-ref-label'))
				.replace(/\\\\textbf\\{([^{}]*)\\}/g, (_, content) => protect(tokens, 'strong', content))
				.replace(/\\\\(?:textit|emph)\\{([^{}]*)\\}/g, (_, content) => protect(tokens, 'em', content))
				.replace(/\\\\texttt\\{([^{}]*)\\}/g, (_, content) => protect(tokens, 'code', content))
				.replace(/\\\\textsc\\{([^{}]*)\\}/g, (_, content) => protect(tokens, 'span', content, 'font-variant: small-caps;'));

			value = escapeHtml(cleanInlineText(value, false));
			for (let index = 0; index < tokens.length; index++) {
				value = value.replaceAll('@@TOKEN_' + index + '@@', tokens[index]);
			}
			return value;
		}

		function protect(tokens, tag, content, style = '') {
			const styleAttribute = style ? ' style="' + escapeHtml(style) + '"' : '';
			const html = '<' + tag + styleAttribute + '>' + escapeHtml(cleanInlineText(content)) + '</' + tag + '>';
			const token = '@@TOKEN_' + tokens.length + '@@';
			tokens.push(html);
			return token;
		}

		function protectReference(tokens, command, key, className) {
			const label = command + ':' + cleanInlineText(key);
			const html = '<span class="latex-ref ' + className + '" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>';
			const token = '@@TOKEN_' + tokens.length + '@@';
			tokens.push(html);
			return token;
		}

		function element(tag, className, text) {
			const node = document.createElement(tag);
			if (className) {
				node.className = className;
			}
			node.textContent = text;
			return node;
		}

		function escapeHtml(value) {
			return value
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}
	</script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function normalizeSelectedText(value: string) {
    return value.replace(/\s+/g, ' ').trim();
}

function getPreviewZoomSettings() {
    const config = vscode.workspace.getConfiguration('latexVisualizer');
    const min = finiteNumber(config.get<number>('previewZoom.min'), 20);
    const max = Math.max(min, finiteNumber(config.get<number>('previewZoom.max'), 300));

    return {
        default: clamp(finiteNumber(config.get<number>('previewZoom.default'), 100), min, max),
        min,
        max,
        step: Math.max(1, finiteNumber(config.get<number>('previewZoom.step'), 10)),
        fontSize: clamp(finiteNumber(config.get<number>('previewFontSize'), 16), 8, 48)
    };
}

function finiteNumber(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

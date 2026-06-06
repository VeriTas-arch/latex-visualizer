const vscode = acquireVsCodeApi();
const preview = document.getElementById('preview');
const file = document.getElementById('file');
const zoom = document.getElementById('zoom');
let currentSource = '';
let zoomSettings = { default: 100, min: 20, max: 300, step: 10, fontSize: 16 };
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
        fontSize: clamp(finiteNumber(settings?.fontSize, 16), 8, 48)
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
    const lines = text.replace(/\r/g, '').split('\n');
    let sourceLine = startLine;

    for (const line of lines) {
        if (!line.trim()) {
            flushParagraph();
            sourceLine++;
            continue;
        }

        const heading = line.trim().match(/^\\(chapter|section|subsection|subsubsection|paragraph)\*?\{([\s\S]*)\}$/);
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

    const algorithmic = source.match(/\\begin\{algorithmic\}([\s\S]*?)\\end\{algorithmic\}/);
    if (!algorithmic) {
        const fallback = document.createElement('p');
        appendInlineLatex(fallback, cleanInlineText(source));
        wrapper.append(fallback);
        return wrapper;
    }

    const list = document.createElement('ol');
    list.className = 'algorithm-steps';
    for (const rawLine of algorithmic[1].split('\n')) {
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

    const command = trimmed.match(/^\\(REQUIRE|ENSURE|STATE)\s+([\s\S]*)$/);
    if (command) {
        const labels = { REQUIRE: 'Require', ENSURE: 'Ensure', STATE: '' };
        return { keyword: labels[command[1]], text: command[2] };
    }

    const loop = trimmed.match(/^\\FOR\{([\s\S]*)\}$/);
    if (loop) {
        return { keyword: 'For', text: loop[1] };
    }

    if (/^\\ENDFOR\b/.test(trimmed)) {
        return { keyword: 'EndFor', text: '' };
    }

    return { keyword: '', text: trimmed };
}

function renderFigure(source) {
    const figure = document.createElement('figure');
    figure.className = 'figure-placeholder';
    const images = [...source.matchAll(/\\includegraphics(?:\[([^\]]*)\])?\{([^}]*)\}/g)];

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
    const tableSource = source.match(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/);
    if (!tableSource) {
        return element('p', 'placeholder', cleanInlineText(readCommandArgument(source, 'caption') || '[table]'));
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    const rows = tableSource[1]
        .replace(/\\(toprule|midrule|bottomrule|hline)\b/g, '')
        .split(/\\\\(?:\s*\[[^\]]*\])?/g)
        .map((row) => row.trim())
        .filter((row) => row && !/^\\+$/.test(row));

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = document.createElement('tr');
        const cells = rows[rowIndex].split(/(?<!\\)&/g);
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
                '\\ang': '#1^\\circ',
                '\\bm': '\\boldsymbol{#1}',
                '\\SI': '#1\\,\\mathrm{#2}',
                '\\SIrange': '#1--#2\\,\\mathrm{#3}'
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
            const endToken = '\\end{' + block.name + '}';
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

        if (source.startsWith('\\[', i)) {
            i = pushDelimited(parts, source, textStart, i, i + 2, '\\]', true);
            textStart = i;
            continue;
        }

        if (source.startsWith('\\(', i)) {
            i = pushDelimited(parts, source, textStart, i, i + 2, '\\)', false);
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
            const endToken = '\\end{' + env.name + '}';
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

        if (source[i] === '$' && source[i - 1] !== '\\' && source[i + 1] !== '$') {
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
        if (source[i] === '%' && source[i - 1] !== '\\') {
            i = skipComment(source, i);
            continue;
        }
        if (source[i] === '$' && source[i - 1] !== '\\') {
            pushText(parts, source.slice(textStart, start), lineAt(source, textStart));
            parts.push({ type: 'math', value: source.slice(start + 1, i), display: false, env: '', line: lineAt(source, start) });
            return i + 1;
        }
        i++;
    }
    return start + 1;
}

function displayEnvAt(source, index) {
    const match = source.slice(index).match(/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)\}/);
    if (!match) {
        return undefined;
    }
    return { name: match[1], base: match[1].replace('*', ''), open: match[0] };
}

function blockEnvAt(source, index) {
    const match = source.slice(index).match(/^\\begin\{(figure\*?|table\*?|algorithm\*?|tabular)\}(?:\{[^}]*\})?/);
    if (!match) {
        return undefined;
    }
    return { name: match[1], base: match[1].replace('*', ''), open: match[0] };
}

function skipComment(source, index) {
    const nextLine = source.indexOf('\n', index);
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
        if (source[i] === '\n') {
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
        .replace(/\\label\{[^}]*\}/g, '')
        .replace(/\\nonumber\b/g, '')
        .replace(/\\notag\b/g, '')
        .trim();

    if (env === 'align' || env === 'flalign' || env === 'alignat') {
        normalized = '\\begin{aligned}' + normalized + '\\end{aligned}';
    } else if (env === 'gather') {
        normalized = '\\begin{gathered}' + normalized + '\\end{gathered}';
    } else if (env === 'multline') {
        normalized = '\\begin{aligned}' + normalized + '\\end{aligned}';
    }

    return normalized;
}

function readCommandArgument(source, command) {
    const start = source.indexOf('\\' + command + '{');
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
    const width = options.match(/width\s*=\s*([^,\]]+)/);
    const height = options.match(/height\s*=\s*([^,\]]+)/);
    const widthPercent = width ? lengthToPercent(width[1]) : undefined;
    return {
        width: width ? width[1].trim() : '',
        height: height ? height[1].trim() : '',
        widthPercent
    };
}

function lengthToPercent(value) {
    const normalized = value.replace(/\s/g, '');
    if (normalized === '\\linewidth' || normalized === '\\textwidth') {
        return 100;
    }

    const fraction = normalized.match(/^(0?\.\d+|\d+(?:\.\d+)?)\\(?:line|text)width$/);
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
        .replace(/\\label\{[^}]*\}/g, '')
        .replace(/\\(cite|citet|citep|ref|eqref|autoref|cref)\{([^}]*)\}/g, '$2')
        .replace(/\\SIrange\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g, '$1-$2 $3')
        .replace(/\\SI\{([^}]*)\}\{([^}]*)\}/g, '$1 $2')
        .replace(/\\si\{([^}]*)\}/g, '$1')
        .replace(/\\ang\{([^}]*)\}/g, '$1 deg')
        .replace(/\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/g, '[image]')
        .replace(/\\(centering|small|footnotesize|normalsize)\b/g, '')
        .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, '')
        .replace(/\\(textbf|textit|emph|texttt|textsc)\{([^{}]*)\}/g, '$2')
        .replace(/\\%/g, '%')
        .replace(/\\&/g, '&')
        .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '')
        .replace(/[{}]/g, '')
        .replace(/~+/g, ' ')
        .replace(/\s+/g, ' ');

    return trim ? value.trim() : value;
}

function inlineMarkup(text) {
    const tokens = [];
    let value = text
        .replace(/\\(cite|citet|citep)\{([^}]*)\}/g, (_, command, key) => protectReference(tokens, command, key, 'latex-ref-cite'))
        .replace(/\\(ref|eqref|autoref|cref)\{([^}]*)\}/g, (_, command, key) => protectReference(tokens, command, key, 'latex-ref-label'))
        .replace(/\\textbf\{([^{}]*)\}/g, (_, content) => protect(tokens, 'strong', content))
        .replace(/\\(?:textit|emph)\{([^{}]*)\}/g, (_, content) => protect(tokens, 'em', content))
        .replace(/\\texttt\{([^{}]*)\}/g, (_, content) => protect(tokens, 'code', content))
        .replace(/\\textsc\{([^{}]*)\}/g, (_, content) => protect(tokens, 'span', content, 'font-variant: small-caps;'));

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

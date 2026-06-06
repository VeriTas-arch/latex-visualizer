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
                    vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist'),
                    vscode.Uri.joinPath(this.extensionUri, 'media')
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
        const previewCss = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.css'));
        const previewJs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${katexCss}">
    <link rel="stylesheet" href="${previewCss}">
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
    <script nonce="${nonce}" src="${previewJs}"></script>
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

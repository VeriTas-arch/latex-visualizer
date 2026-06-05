import fs from 'node:fs';
import path from 'node:path';
import katex from 'katex';

const samplesDir = path.join(process.cwd(), 'samples');
const files = fs.readdirSync(samplesDir).filter((file) => file.endsWith('.tex')).sort();
const macros = {
  '\\ang': '#1^\\circ',
  '\\bm': '\\boldsymbol{#1}',
  '\\SI': '#1\\,\\mathrm{#2}',
  '\\SIrange': '#1--#2\\,\\mathrm{#3}'
};

let total = 0;
let failures = 0;

for (const file of files) {
  const source = fs.readFileSync(path.join(samplesDir, file), 'utf8');
  const mathParts = scanMath(source).filter((part) => part.type === 'math');
  let fileFailures = 0;

  for (const part of mathParts) {
    total++;
    try {
      katex.renderToString(normalizeMath(part.value, part.env), {
        displayMode: part.display,
        throwOnError: true,
        strict: false,
        macros
      });
    } catch (error) {
      fileFailures++;
      failures++;
      if (fileFailures <= 3) {
        const message = error && error.message ? error.message : String(error);
        console.error(`${file}:${part.line}: ${message}`);
      }
    }
  }

  const status = fileFailures === 0 ? 'ok' : `${fileFailures} errors`;
  console.log(`${file}: ${mathParts.length} formulas, ${status}`);
}

console.log(`Total: ${total} formulas, ${failures} render errors`);
process.exitCode = failures === 0 ? 0 : 1;

function scanMath(source) {
  const parts = [];
  let textStart = 0;
  let i = 0;

  while (i < source.length) {
    if (source[i] === '%') {
      i = skipComment(source, i);
      continue;
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
      const endToken = `\\end{${env.name}}`;
      const contentStart = i + env.open.length;
      const end = source.indexOf(endToken, contentStart);
      if (end !== -1) {
        pushText(parts, source.slice(textStart, i));
        parts.push({
          type: 'math',
          value: source.slice(contentStart, end),
          display: true,
          env: env.base,
          line: lineNumberAt(source, i)
        });
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

  pushText(parts, source.slice(textStart));
  return parts;
}

function pushDelimited(parts, source, textStart, start, contentStart, close, display) {
  const end = source.indexOf(close, contentStart);
  if (end === -1) {
    return start + 1;
  }
  pushText(parts, source.slice(textStart, start));
  parts.push({
    type: 'math',
    value: source.slice(contentStart, end),
    display,
    env: '',
    line: lineNumberAt(source, start)
  });
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
      pushText(parts, source.slice(textStart, start));
      parts.push({
        type: 'math',
        value: source.slice(start + 1, i),
        display: false,
        env: '',
        line: lineNumberAt(source, start)
      });
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

function skipComment(source, index) {
  const nextLine = source.indexOf('\n', index);
  return nextLine === -1 ? source.length : nextLine + 1;
}

function pushText(parts, value) {
  if (value) {
    parts.push({ type: 'text', value });
  }
}

function normalizeMath(source, env) {
  let normalized = source
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\nonumber\b/g, '')
    .replace(/\\notag\b/g, '')
    .trim();

  if (env === 'align' || env === 'flalign' || env === 'alignat') {
    normalized = `\\begin{aligned}${normalized}\\end{aligned}`;
  } else if (env === 'gather') {
    normalized = `\\begin{gathered}${normalized}\\end{gathered}`;
  } else if (env === 'multline') {
    normalized = `\\begin{aligned}${normalized}\\end{aligned}`;
  }

  return normalized;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') {
      line++;
    }
  }
  return line;
}

/** Markdown to Telegram's supported HTML subset. */
import type { Nodes } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { tokenizeMarkdown, type MarkdownBlock } from './markdown.js';
import { blockToPlain } from './plain.js';
import { splitByGraphemes } from './segment.js';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function childrenToHtml(node: { children: Nodes[] }): string {
  return node.children.map(nodeToHtml).join('');
}

function nodeToHtml(node: Nodes): string {
  switch (node.type) {
    case 'text': return escapeHtml(node.value);
    case 'strong': return `<b>${childrenToHtml(node)}</b>`;
    case 'emphasis': return `<i>${childrenToHtml(node)}</i>`;
    case 'delete': return `<s>${childrenToHtml(node)}</s>`;
    case 'inlineCode': return `<code>${escapeHtml(node.value)}</code>`;
    case 'code': return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
    case 'link': return `<a href="${escapeAttr(node.url)}">${childrenToHtml(node)}</a>`;
    case 'image': return escapeHtml(node.alt ?? node.url);
    case 'break': return '\n';
    case 'heading': return `<b>${childrenToHtml(node)}</b>`;
    case 'blockquote': return `<blockquote>${childrenToHtml(node)}</blockquote>`;
    case 'paragraph': return childrenToHtml(node);
    case 'list':
      return node.children.map((item, index) => {
        const marker = node.ordered ? `${(node.start ?? 1) + index}.` : '-';
        return `${marker} ${childrenToHtml(item)}`;
      }).join('\n');
    case 'listItem': return childrenToHtml(node);
    case 'table': return `<pre>${escapeHtml(toString(node))}</pre>`;
    case 'tableRow': return node.children.map((cell) => toString(cell)).join(' | ');
    case 'tableCell': return childrenToHtml(node);
    case 'html': return escapeHtml(node.value);
    case 'thematicBreak': return '---';
    case 'footnoteDefinition': return childrenToHtml(node);
    case 'footnoteReference': return escapeHtml(node.label ?? node.identifier);
    case 'linkReference': return childrenToHtml(node);
    case 'imageReference': return escapeHtml(node.alt ?? node.label ?? node.identifier);
    case 'definition': return '';
    case 'yaml': return escapeHtml(node.value);
    case 'root': return childrenToHtml(node);
  }
}

/** Kept as a public helper; parsing now happens through mdast rather than regex. */
export function inlineMarkdownToHtml(text: string): string {
  const block = tokenizeMarkdown(text)[0];
  return block ? nodeToHtml(block.node) : '';
}

export function blockToHtml(block: MarkdownBlock): string {
  return nodeToHtml(block.node);
}

const HTML_MAX = 4096;

/**
 * Oversized generated HTML degrades to escaped text chunks. Every returned
 * chunk is independently valid Telegram HTML; no tag is left open across a
 * message boundary.
 */
export function safeHtmlSplit(html: string, maxLength = HTML_MAX): string[] {
  if (html.length <= maxLength) return [html];
  const plain = html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const chunks: string[] = [];
  let current = '';
  for (const item of segmenter.segment(plain)) {
    const escaped = escapeHtml(item.segment);
    if (current && current.length + escaped.length > maxLength) {
      chunks.push(current);
      current = '';
    }
    current += escaped;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function renderHtml(source: string, limit = HTML_MAX): string[] {
  if (!source) return [];
  const messages: string[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer) messages.push(buffer);
    buffer = '';
  };
  for (const block of tokenizeMarkdown(source)) {
    const html = blockToHtml(block);
    if (html.length > limit) {
      flush();
      messages.push(...splitByGraphemes(blockToPlain(block), limit).map(escapeHtml));
      continue;
    }
    if (buffer && buffer.length + html.length + 1 > limit) flush();
    buffer += `${buffer ? '\n' : ''}${html}`;
  }
  flush();
  return messages;
}

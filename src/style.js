'use strict';
// Depth selectors and palette adapted from Raj-Srikar/colorize-folder-tree (MIT).
// CDP style-element injection adapted from poiley/slack-themes (MIT).
// See THIRD_PARTY_NOTICES.md and third-party/ for source revisions and licenses.
const STYLE_ID = 'folder-guide-colors-style';
const PALETTE = ['#ffd700', '#e387ff', '#61afef', '#98c379', '#fea364', '#47e5ed'];
const SCOPE = '.explorer-folders-view .monaco-tl-indent > .indent-guide';
const CSS = PALETTE.map((color, index) => `${SCOPE}:nth-child(6n+${index + 1}) { border-left-color: ${color} !important; opacity: 0.65 !important; }`).join('\n') +
  `\n${SCOPE}.active { opacity: 1 !important; }`;

function styleExpression(enabled, expectedUrl) {
  return `(${function (enabled, expectedUrl, styleId, css) {
    // Recheck after discovery in case the target navigated before this request.
    if (location.href !== expectedUrl || !document.head) return false;
    const existing = document.getElementById(styleId);
    if (!enabled) {
      existing?.remove();
      return true;
    }
    const style = existing || document.createElement('style');
    style.id = styleId;
    if (style.textContent !== css) style.textContent = css;
    if (!existing) document.head.appendChild(style);
    return true;
  }.toString()})(${JSON.stringify(enabled)}, ${JSON.stringify(expectedUrl)}, ${JSON.stringify(STYLE_ID)}, ${JSON.stringify(CSS)})`;
}

module.exports = { CSS, STYLE_ID, styleExpression };

'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CSS, STYLE_ID, styleExpression } = require('../src/style');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    const guides = '<div class="indent-guide"></div>'.repeat(40);
    await page.setContent(`<style>.indent-guide { display:inline-block;width:8px;height:24px;border-left:1px solid rgb(90,90,90);opacity:0; }</style><div class="explorer-folders-view"><div class="monaco-tl-indent">${guides}</div></div><div id="outside"><div class="monaco-tl-indent">${guides}</div></div>`);
    await page.evaluate(styleExpression(true, 'about:blank'));
    await page.evaluate(styleExpression(true, 'about:blank'));
    assert.equal(await page.locator('#' + STYLE_ID).count(), 1);
    const colors = await page.locator('.explorer-folders-view .indent-guide').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderLeftColor));
    assert.equal(colors[0], 'rgb(255, 215, 0)');
    assert.equal(colors[1], 'rgb(227, 135, 255)');
    assert.equal(colors[5], 'rgb(71, 229, 237)');
    assert.equal(colors[6], 'rgb(255, 215, 0)');
    assert.equal(colors[12], 'rgb(255, 215, 0)');
    assert.equal(colors[39], 'rgb(152, 195, 121)');
    assert.equal(await page.locator('#outside .indent-guide').first().evaluate(node => getComputedStyle(node).borderLeftColor), 'rgb(90, 90, 90)');
    await page.locator('.explorer-folders-view .indent-guide').first().evaluate(node => node.classList.add('active'));
    assert.equal(await page.locator('.explorer-folders-view .indent-guide').first().evaluate(node => getComputedStyle(node).opacity), '1');
    await page.evaluate(styleExpression(false, 'about:blank'));
    assert.equal(await page.locator('#' + STYLE_ID).count(), 0);
    assert.equal(await page.locator('.explorer-folders-view .indent-guide').first().evaluate(node => getComputedStyle(node).borderLeftColor), 'rgb(90, 90, 90)');
    assert.ok(CSS.length < 2000);
    console.log('Chromium computed styles: PASS (40 levels, scope, active guide, idempotence, disable).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

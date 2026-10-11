// タイマーの小窓（ピクチャー・イン・ピクチャー）。
// ボタンを押すと、タイマーを描いた動画が小窓になり、もう一度押すと閉じること。
//
// Playwright が無い環境、小窓に対応していないブラウザでは飛ばす。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadPlaywright, startTestServer } from "./server.mjs";

const playwright = await loadPlaywright();
const options = playwright ? {} : { skip: "Playwright が無いので飛ばします" };

let server = null;
let browser = null;

before(async () => {
  if (!playwright) return;
  browser = await playwright.chromium.launch();
  server = await startTestServer();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("ホームの小窓ボタンでタイマーが小窓になり、もう一度押すと閉じる", options, async (t) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${server.origin}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0);
  if (!(await page.evaluate(() => document.pictureInPictureEnabled === true))) {
    t.skip("このブラウザは小窓に対応していない");
    await context.close();
    return;
  }
  // 小窓の元になる動画が、タップより前に用意されている。
  await page.waitForFunction(() => (document.querySelector("video.pip-source")?.readyState ?? 0) >= 1);

  const button = page.locator(".pip-btn");
  await button.click();
  await page.waitForFunction(() => document.pictureInPictureElement?.classList.contains("pip-source"));
  await page.waitForFunction(() => document.querySelector(".pip-btn")?.getAttribute("aria-pressed") === "true");

  await page.locator(".pip-btn").click();
  await page.waitForFunction(() => document.pictureInPictureElement === null);
  await page.waitForFunction(() => document.querySelector(".pip-btn")?.getAttribute("aria-pressed") === "false");
  assert.deepEqual(errors, []);
  await context.close();
});

test("小窓に描く数字は、桁が増えても枠に収まる", options, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.origin}/index.html`);
  const widths = await page.evaluate(async () => {
    const { drawPipFrame } = await import("./src/pip-timer.js");
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 270;
    const context = canvas.getContext("2d");
    return ["05:12", "1:02:35", "12:34:56"].map((main) => {
      // 下の行を描くと文字の大きさが変わるので、数字だけを描いてから測る。
      drawPipFrame(context, { main });
      return context.measureText(main).width;
    });
  });
  for (const width of widths) assert.ok(width <= 440, `数字がはみ出している（幅 ${width}）`);
  await context.close();
});

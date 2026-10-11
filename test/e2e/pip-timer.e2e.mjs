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

/**
 * iPhone の Safari のふるまいを Chromium で再現する。
 *   ・標準の小窓（requestPictureInPicture）は無く、webkitSetPresentationMode だけがある
 *   ・その場で描いた映像（srcObject）は小窓にできない
 * standalone を true にすると、ホーム画面のアプリとして開いた状態（小窓が断られる）にする。
 */
function imitateIphone({ standalone = false } = {}) {
  return ({ standalone }) => {
    Object.defineProperty(Document.prototype, "pictureInPictureEnabled", { configurable: true, get: () => false });
    Object.defineProperty(navigator, "standalone", { configurable: true, get: () => standalone });
    const proto = HTMLVideoElement.prototype;
    proto.webkitSupportsPresentationMode = function () { return !this.srcObject; };
    Object.defineProperty(proto, "webkitPresentationMode", {
      configurable: true,
      get() { return this.__mode ?? "inline"; },
    });
    proto.webkitSetPresentationMode = function (mode) {
      if (standalone && mode === "picture-in-picture") {
        throw new DOMException("The video element does not support the Picture-in-Picture mode.", "NotSupportedError");
      }
      this.__mode = mode;
      this.dispatchEvent(new Event("webkitpresentationmodechanged"));
    };
  };
}

async function openImitatingIphone(options) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(imitateIphone(options), options);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const alerts = [];
  page.on("dialog", (dialog) => { alerts.push(dialog.message()); dialog.accept(); });
  await page.goto(`${server.origin}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0);
  return { context, page, errors, alerts };
}

test("iPhone の Safari では、前もって作ったタイマーの動画を小窓にする", options, async () => {
  const { context, page, errors, alerts } = await openImitatingIphone({ standalone: false });
  await page.waitForFunction(() => document.querySelectorAll("video.pip-source").length === 2);

  await page.locator(".pip-btn").click();
  await page.waitForFunction(() => document.querySelector(".pip-btn")?.getAttribute("aria-pressed") === "true");
  const chosen = await page.evaluate(() => [...document.querySelectorAll("video.pip-source")]
    .filter((video) => video.webkitPresentationMode === "picture-in-picture")
    .map((video) => ({ src: video.getAttribute("src"), stream: Boolean(video.srcObject) })));
  assert.deepEqual(chosen, [{ src: "./media/timer.mp4", stream: false }]);
  assert.deepEqual(alerts, []);

  await page.locator(".pip-btn").click();
  await page.waitForFunction(() => document.querySelector(".pip-btn")?.getAttribute("aria-pressed") === "false");
  assert.deepEqual(errors, []);
  await context.close();
});

test("iPhone のホーム画面のアプリでは、Safari で開けば使えることを案内する", options, async () => {
  const { context, page, errors, alerts } = await openImitatingIphone({ standalone: true });
  await page.locator(".pip-btn").click();
  await page.waitForFunction(() => document.querySelector(".pip-btn")?.getAttribute("aria-pressed") === "false");
  await page.waitForTimeout(200);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /ホーム画面に追加したアプリ/);
  assert.match(alerts[0], /Safari/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("タイマーの動画は、先頭だけ読めば再生を始められる形になっている", options, async () => {
  // faststart で作っているので、再生に要る情報（moov）が先頭にある。
  // 後ろにあると、iPhone は小窓を開く前に動画をまるごと読もうとする。
  const response = await fetch(`${server.origin}/media/timer.mp4`);
  const head = Buffer.from(await response.arrayBuffer()).subarray(0, 64 * 1024);
  assert.equal(head.subarray(4, 8).toString(), "ftyp");
  const moov = head.indexOf("moov");
  const mdat = head.indexOf("mdat");
  assert.ok(moov > 0, "先頭 64KB に moov が無い");
  assert.ok(mdat === -1 || moov < mdat, "moov が mdat より後ろにある");
});

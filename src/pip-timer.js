// タイマーの小窓（ピクチャー・イン・ピクチャー）。
//
// YouTube の小窓のように、ほかのアプリを開いていてもタイマーを画面の隅に出しておく。
// Web では「任意の画面」を小窓にはできないが、「動画」なら小窓にできる。やり方は2つある。
//
//   1. その場で描いた映像（PC の Chrome / Edge / Safari）
//      タイマーをキャンバスに描き、動画（captureStream）として再生して小窓にする。
//      例題名も出せる。
//   2. 前もって作った動画（iPhone / iPad の Safari）
//      iPhone は「その場で描いた映像」を小窓にできない（WebKit の制限）。
//      そこで、1秒ごとに数字が進む10時間の動画（media/timer.mp4）を用意しておき、
//      再生位置をタイマーの秒数に合わせて小窓にする。動画は自分で進むので、
//      ほかのアプリを開いて画面の処理が止まっても、数字は進み続ける。
//
// iPhone のホーム画面に追加したアプリでは、iOS が小窓そのものを許していない。
// その場合は、Safari で開けば使えることを案内する。
//
// 小窓の位置と大きさは OS が決める（指でつまんで隅へ動かせる）。
// 中身はこの端末のタイマーをそのまま描くだけで、学習の記録には一切触れない。

const WIDTH = 480;
const HEIGHT = 270;
// 描き直す間隔。秒の表示なので 4回/秒 で十分（裏に回ると OS がさらに間引く）。
const FRAME_MS = 250;

// 前もって作った動画（iPhone 用）。tools/build-timer-video.sh で作る。
const CLIP_URL = './media/timer.mp4';
const CLIP_SECONDS = 36000;

let canvas = null;
// その場で描いた映像の動画（1 の方式）。
let video = null;
// 前もって作った動画（2 の方式）。WebKit（iPhone / iPad / Mac の Safari）でだけ用意する。
let clip = null;
let timer = null;
let snapshotOf = () => ({ main: '00:00', sub: '', seconds: 0, paused: true });

const hasStandardPip = (element) => document.pictureInPictureEnabled === true
  && typeof element.requestPictureInPicture === 'function';
const hasWebkitPip = (element) => typeof element.webkitSetPresentationMode === 'function';

/** ホーム画面に追加したアプリとして開いているか（iPhone では小窓が使えない）。 */
export function isStandaloneApp() {
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
}

/** この端末で小窓のボタンを出すか。動画の小窓の仕組みがまったく無い端末では出さない。 */
export function pipSupported() {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  return hasStandardPip(probe) || hasWebkitPip(probe);
}

const isPip = (element) => Boolean(element)
  && (document.pictureInPictureElement === element || element.webkitPresentationMode === 'picture-in-picture');

/** いま小窓を出しているか。 */
export function pipActive() {
  return isPip(video) || isPip(clip);
}

/**
 * 1枚ぶんを描く。
 * main は大きな数字（今日の合計・チャレンジの残りなど）、sub はその下の小さな1行。
 * tone が danger のときは数字を赤くする（チャレンジ中）。paused は薄く表示する。
 */
export function drawPipFrame(context, { main, sub = '', tone = null, paused = false }) {
  context.fillStyle = '#0b0b0d';
  context.fillRect(0, 0, WIDTH, HEIGHT);

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const color = tone === 'danger' ? '#f87171' : '#fafafa';
  context.fillStyle = paused ? '#71717a' : color;
  const digits = String(main);
  // 「1:23:45」のように桁が増えても、はみ出さない大きさまで小さくする。
  let size = 150;
  const fontOf = (px) => `600 ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  context.font = fontOf(size);
  while (size > 40 && context.measureText(digits).width > WIDTH - 40) {
    size -= 6;
    context.font = fontOf(size);
  }
  context.fillText(digits, WIDTH / 2, sub ? HEIGHT / 2 - 22 : HEIGHT / 2);

  if (sub) {
    context.fillStyle = '#a1a1aa';
    context.font = '500 30px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
    let text = String(sub);
    while (text.length > 1 && context.measureText(text).width > WIDTH - 40) text = `${text.slice(0, -2)}…`;
    context.fillText(text, WIDTH / 2, HEIGHT - 48);
  }
}

/** 前もって作った動画の再生位置を、タイマーの秒数に合わせる。 */
function syncClip(snapshot, { force = false } = {}) {
  if (!clip) return;
  const target = Math.min(CLIP_SECONDS - 1, Math.max(0, Number(snapshot.seconds) || 0));
  // 少しのずれは直さない（直すたびに画面がちらつくため）。
  if (force || Math.abs(clip.currentTime - target) > 1.5) {
    try { clip.currentTime = target; } catch { /* まだ読み込めていない */ }
  }
  if (snapshot.paused) {
    if (!clip.paused) clip.pause();
  } else if (clip.paused) {
    clip.play().catch(() => {});
  }
}

function draw() {
  const snapshot = snapshotOf();
  if (canvas) drawPipFrame(canvas.getContext('2d'), snapshot);
  if (isPip(clip)) syncClip(snapshot);
}

/**
 * 小窓に使う動画を前もって用意しておく。
 * 小窓を開く操作は「タップの直後」でないと断られるため、
 * タップしてから動画を読み込んでいては間に合わない。起動時に呼んでおく。
 *
 * getSnapshot は、いま小窓に出す内容を返す関数。
 *   main / sub … 描く文字（1 の方式）
 *   seconds    … 数えている秒数（2 の方式の再生位置）
 *   tone       … danger なら数字を赤く
 *   paused     … 止まっているか
 */
export function preparePip(getSnapshot) {
  if (getSnapshot) snapshotOf = getSnapshot;
  if (video || clip || !pipSupported()) return;

  const canStream = typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  if (canStream) {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    video = sourceVideo();
    video.srcObject = canvas.captureStream(4);
    // 小窓の再生ボタンで止められると数字が止まって見えるので、すぐ再生し直す。
    video.addEventListener('pause', () => { video.play().catch(() => {}); });
    video.play().catch(() => {});
  }

  // WebKit（Safari）では、その場で描いた映像を小窓にできないことがある（iPhone）。
  // 代わりに使う、前もって作った動画も用意する。読み込むのは先頭の情報だけ。
  const probe = document.createElement('video');
  if (hasWebkitPip(probe)) {
    clip = sourceVideo();
    clip.preload = 'metadata';
    clip.src = CLIP_URL;
    // iPhone は preload を無視して、再生するまで何も読み込まない。読み込みが済んでいないと
    // 小窓にできないので、音の無い再生を一瞬だけして、すぐ止めておく。
    clip.play().then(() => { if (!isPip(clip)) clip.pause(); }).catch(() => {});
  }

  draw();
  timer = setInterval(draw, FRAME_MS);
}

/** 小窓の元にする、見えない大きさの動画（Safari は文書の中にある動画でないと小窓にできない）。 */
function sourceVideo() {
  const element = document.createElement('video');
  element.className = 'pip-source';
  element.muted = true;
  element.playsInline = true;
  element.setAttribute('playsinline', '');
  element.setAttribute('muted', '');
  element.setAttribute('aria-hidden', 'true');
  element.disablePictureInPicture = false;
  // 対応している端末では、アプリを離れたときに自動で小窓へ移る。
  element.setAttribute('autopictureinpicture', '');
  element.autoPictureInPicture = true;
  document.body.append(element);
  return element;
}

/** 小窓にする動画を選ぶ。その場で描いた映像が使えればそれ、だめなら前もって作った動画。 */
function chooseVideo() {
  if (video) {
    // WebKit は、この動画を小窓にできるかを教えてくれる（iPhone では false になる）。
    const webkitSays = typeof video.webkitSupportsPresentationMode === 'function'
      ? video.webkitSupportsPresentationMode('picture-in-picture')
      : null;
    if (webkitSays === true || (webkitSays === null && hasStandardPip(video))) return video;
  }
  return clip ?? video;
}

async function enter(element) {
  if (hasStandardPip(element)) await element.requestPictureInPicture();
  else element.webkitSetPresentationMode('picture-in-picture');
}

async function leave() {
  if (document.pictureInPictureElement) await document.exitPictureInPicture();
  for (const element of [video, clip]) {
    if (element?.webkitPresentationMode === 'picture-in-picture') element.webkitSetPresentationMode('inline');
  }
}

/**
 * 小窓を開く（開いていれば閉じる）。タップの処理の中から呼ぶこと。
 * 開けなかったときの reason: standalone（ホーム画面のアプリなので iOS が許していない）/
 * unsupported（小窓の仕組みが無い）/ failed（そのほか）。
 */
export async function togglePip() {
  if (!video && !clip) preparePip();
  try {
    if (pipActive()) {
      await leave();
      return { ok: true, active: false };
    }
    const target = chooseVideo();
    if (!target) return { ok: false, reason: 'unsupported' };
    const snapshot = snapshotOf();
    if (target === clip) {
      syncClip({ ...snapshot, paused: true }, { force: true });
      if (!snapshot.paused) clip.play().catch(() => {});
    } else {
      drawPipFrame(canvas.getContext('2d'), snapshot);
      // 再生が止まっていると小窓にできない端末があるので、念のため再生してから頼む。
      target.play().catch(() => {});
    }
    await enter(target);
    return { ok: true, active: true };
  } catch (error) {
    return {
      ok: false,
      reason: isStandaloneApp() ? 'standalone' : 'failed',
      message: error?.message ?? String(error),
    };
  }
}

/** 小窓の開け閉めを知らせる（ボタンの表示を切り替えるため）。 */
export function onPipChange(listener) {
  for (const element of [video, clip]) {
    if (!element) continue;
    element.addEventListener('enterpictureinpicture', listener);
    element.addEventListener('leavepictureinpicture', listener);
    element.addEventListener('webkitpresentationmodechanged', listener);
  }
}

/** テスト用に、用意したものを片づける。 */
export function disposePip() {
  clearInterval(timer);
  timer = null;
  video?.remove();
  clip?.remove();
  video = null;
  clip = null;
  canvas = null;
}

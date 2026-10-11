// タイマーの小窓（ピクチャー・イン・ピクチャー）。
//
// YouTube の小窓のように、ほかのアプリを開いていてもタイマーを画面の隅に出しておく。
// Web では「任意の画面」を小窓にはできないが、「動画」なら小窓にできる。
// そこで、タイマーをキャンバスに描き、それを動画（captureStream）として再生して小窓にする。
// iPhone / iPad の Safari と、PC の Chrome / Edge / Safari のどれでも同じ仕組みで動く。
//
// 小窓の位置と大きさは OS が決める（指でつまんで隅へ動かせる）。
// 中身はこの端末のタイマーをそのまま描くだけで、学習の記録には一切触れない。

const WIDTH = 480;
const HEIGHT = 270;
// 描き直す間隔。秒の表示なので 4回/秒 で十分（裏に回ると OS がさらに間引く）。
const FRAME_MS = 250;

let canvas = null;
let video = null;
let timer = null;
let snapshotOf = () => ({ main: '00:00', sub: '' });

/** この端末で小窓が使えるか（使えなければボタンを出さない）。 */
export function pipSupported() {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  const canStream = typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const standard = document.pictureInPictureEnabled === true && typeof probe.requestPictureInPicture === 'function';
  const webkit = typeof probe.webkitSupportsPresentationMode === 'function'
    && probe.webkitSupportsPresentationMode('picture-in-picture');
  return canStream && (standard || webkit);
}

/** いま小窓を出しているか。 */
export function pipActive() {
  if (!video) return false;
  return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';
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

function draw() {
  if (!canvas) return;
  drawPipFrame(canvas.getContext('2d'), snapshotOf());
}

/**
 * 小窓に使う動画を前もって用意しておく。
 * 小窓を開く操作は「タップの直後」でないと断られるため、
 * タップしてから動画を読み込んでいては間に合わない。起動時に呼んでおく。
 *
 * getSnapshot は、いま小窓に出す内容（main / sub / tone / paused）を返す関数。
 */
export function preparePip(getSnapshot) {
  if (getSnapshot) snapshotOf = getSnapshot;
  if (video || !pipSupported()) return;

  canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  draw();

  video = document.createElement('video');
  video.className = 'pip-source';
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.disablePictureInPicture = false;
  // 対応している端末では、アプリを離れたときに自動で小窓へ移る。
  video.setAttribute('autopictureinpicture', '');
  video.autoPictureInPicture = true;
  video.srcObject = canvas.captureStream(4);
  // 小窓の再生ボタンで止められると数字が止まって見えるので、すぐ再生し直す。
  video.addEventListener('pause', () => { video.play().catch(() => {}); });
  // Safari は文書の中にある動画でないと小窓にできないので、見えない大きさで置いておく。
  document.body.append(video);
  video.play().catch(() => {});

  timer = setInterval(draw, FRAME_MS);
}

/** 小窓を開く（開いていれば閉じる）。タップの処理の中から呼ぶこと。 */
export async function togglePip() {
  if (!video) preparePip();
  if (!video) return { ok: false, reason: 'unsupported' };
  draw();
  try {
    if (pipActive()) {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else video.webkitSetPresentationMode('inline');
      return { ok: true, active: false };
    }
    // 再生が止まっていると小窓にできない端末があるので、念のため再生してから頼む。
    video.play().catch(() => {});
    if (typeof video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) {
      await video.requestPictureInPicture();
    } else {
      video.webkitSetPresentationMode('picture-in-picture');
    }
    return { ok: true, active: true };
  } catch (error) {
    return { ok: false, reason: 'failed', message: error?.message ?? String(error) };
  }
}

/** 小窓の開け閉めを知らせる（ボタンの表示を切り替えるため）。 */
export function onPipChange(listener) {
  if (!video) return;
  video.addEventListener('enterpictureinpicture', listener);
  video.addEventListener('leavepictureinpicture', listener);
  video.addEventListener('webkitpresentationmodechanged', listener);
}

/** テスト用に、用意したものを片づける。 */
export function disposePip() {
  clearInterval(timer);
  timer = null;
  video?.remove();
  video = null;
  canvas = null;
}

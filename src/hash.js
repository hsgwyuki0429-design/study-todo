// 問題マスタが変わったかどうかを見分けるための短い指紋。
// PWA側とサーバー側で同じ値になる必要があるので、ここに1つだけ置いて共有する。
//
// 指紋には問題マスタの全項目を含める。含めない項目があると、その項目だけを
// 直したときに「変わっていない」と判断され、クラウドへ送られなくなる。

import { QUESTION_FIELDS } from './question-order.js';

/** 問題マスタの中身から、順番によらない指紋（先頭32文字）を作る。 */
export async function hashQuestions(questions = []) {
  const canonical = JSON.stringify(
    [...questions]
      .map((q) => QUESTION_FIELDS.map((field) => q[field] ?? null))
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

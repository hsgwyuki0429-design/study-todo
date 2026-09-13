// 1つずつ順番に実行するための、とても小さな順番待ち。
//
// 1人で使うアプリなので、同時に走る書き込みは多くても数本しかない。
// 「読む→確かめる→書く」の途中に別の書き込みが割り込まないことだけが大事で、
// 速さは要らないため、いちばん単純な直列化にしている。

export function createMutex() {
  let tail = Promise.resolve();
  return function runExclusive(task) {
    const result = tail.then(task, task);
    // 失敗しても列は止めない（次の待ち手が動けなくなるのを防ぐ）。
    tail = result.then(() => {}, () => {});
    return result;
  };
}

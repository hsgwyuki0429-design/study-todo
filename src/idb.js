// 最小限の IndexedDB ラッパー。
// 将来サーバー同期へ差し替えられるよう、このファイルは「保存先」だけを担当し、
// ドメインロジックは api.js 側に置く。

const DB_NAME = 'aochart';
const DB_VERSION = 3;

export const STORES = {
  questions: 'questions',
  records: 'records',
  tasks: 'tasks',
  challenges: 'challenges',
  goals: 'goals',
  meta: 'meta',
  // クラウドへまだ送れていない変更を貯めておく場所（オフライン時の控え）。
  // 既存のストアには手を触れない、足すだけの追加なのでデータは失われない。
  outbox: 'outbox',
  // 予定を別の日へ動かした記録（繰り越し・予定変更）。学習記録と同じく追加専用で、
  // id で重ね合わせるだけなので、同期を何度やり直しても増えない。
  moves: 'moves',
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.questions)) {
        const s = db.createObjectStore(STORES.questions, { keyPath: 'id' });
        s.createIndex('chapter', 'chapter');
        s.createIndex('section', 'section');
        s.createIndex('subject', 'subject');
      }
      if (!db.objectStoreNames.contains(STORES.records)) {
        const s = db.createObjectStore(STORES.records, { keyPath: 'id' });
        s.createIndex('questionId', 'questionId');
        s.createIndex('timestamp', 'timestamp');
        s.createIndex('evaluation', 'evaluation');
      }
      if (!db.objectStoreNames.contains(STORES.tasks)) {
        const s = db.createObjectStore(STORES.tasks, { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(STORES.challenges)) {
        const s = db.createObjectStore(STORES.challenges, { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp');
        s.createIndex('taskId', 'taskId');
      }
      if (!db.objectStoreNames.contains(STORES.goals)) {
        db.createObjectStore(STORES.goals, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.outbox)) {
        const s = db.createObjectStore(STORES.outbox, { keyPath: 'key' });
        s.createIndex('type', 'type');
      }
      // v3 で足した。既存のストアには触れないので、いままでのデータは残る。
      if (!db.objectStoreNames.contains(STORES.moves)) {
        const s = db.createObjectStore(STORES.moves, { keyPath: 'id' });
        s.createIndex('fromDate', 'fromDate');
        s.createIndex('toDate', 'toDate');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          t.oncomplete = () => resolve();
        }
      })
  );
}

export const idb = {
  /** Do not acknowledge an edit queued while a previous version was in flight. */
  acknowledgeOutbox(entries) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORES.outbox, 'readwrite');
      const store = t.objectStore(STORES.outbox);
      for (const entry of entries) {
        const request = store.get(entry.key);
        request.onsuccess = () => {
          if (JSON.stringify(request.result) === JSON.stringify(entry)) store.delete(entry.key);
        };
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  },
  /** Session and its study_end outbox entry commit together, including across tabs. */
  updateSession(mutate) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction([STORES.meta, STORES.outbox], 'readwrite');
      const meta = t.objectStore(STORES.meta);
      const request = meta.get('session');
      let result;
      request.onsuccess = () => {
        try {
          result = mutate(request.result?.value ?? null);
          if (result.session) meta.put({ key: 'session', value: result.session });
          if (result.event) t.objectStore(STORES.outbox).put(result.event);
        } catch (error) { t.abort(); reject(error); }
      };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  },
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  byIndex: (store, index, value) =>
    tx(store, 'readonly', (s) => s.index(index).getAll(value)),
  /**
   * 1つの索引にぶら下がるものを、まとめて入れ替える。
   *
   * 消すのと入れるのを別々のトランザクションでやると、その合間に落ちたときに
   * 「消えただけ」の状態が残る。IndexedDB のトランザクションは全部通るか
   * 1つも通らないかのどちらかなので、ここで1つにまとめておく。
   */
  replaceByIndex(store, index, value, values) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, 'readwrite');
          const os = t.objectStore(store);
          const cursorRequest = os.index(index).openCursor(IDBKeyRange.only(value));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
              return;
            }
            // 消し終わってから入れる。ここまでが同じトランザクションの中。
            values.forEach((v) => os.put(v));
          };
          t.oncomplete = () => resolve(values.length);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  },
  putAll(store, values) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, 'readwrite');
          const os = t.objectStore(store);
          values.forEach((v) => os.put(v));
          t.oncomplete = () => resolve(values.length);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  },
};

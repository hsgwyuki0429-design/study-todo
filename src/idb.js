// 最小限の IndexedDB ラッパー。
// 将来サーバー同期へ差し替えられるよう、このファイルは「保存先」だけを担当し、
// ドメインロジックは api.js 側に置く。

const DB_NAME = 'aochart';
const DB_VERSION = 2;

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
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  byIndex: (store, index, value) =>
    tx(store, 'readonly', (s) => s.index(index).getAll(value)),
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

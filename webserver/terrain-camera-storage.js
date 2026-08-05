const DATABASE_NAME = 'atlantis-camera-state';
const DATABASE_VERSION = 1;
const STORE_NAME = 'camera';

let databasePromise = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('camera database open failed'));
  });
  return databasePromise;
}

async function runRequest(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let result = null;
    request.onsuccess = () => { result = request.result ?? null; };
    request.onerror = () => reject(request.error ?? new Error('camera storage request failed'));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(
      transaction.error ?? new Error('camera storage transaction aborted'),
    );
  });
}

export function readCameraState(key) {
  return runRequest('readonly', store => store.get(key));
}

export function writeCameraState(key, value) {
  return runRequest('readwrite', store => store.put(value, key));
}

export function removeCameraState(key) {
  return runRequest('readwrite', store => store.delete(key));
}

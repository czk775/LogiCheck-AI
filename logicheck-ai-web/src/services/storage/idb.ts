/**
 * IndexedDB 文件存储：仅用于前端 Mock 演示阶段保存用户上传的原始文件，
 * 以支持刷新后的原件预览。后端接入后应由私有对象存储替代。
 * 移植自已确认原型（logicheck_preview_files_v1）。
 */

const IDB_NAME = 'logicheck_preview_files_v1'

function withDB<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持本地文件存储'))
      return
    }
    const rq = indexedDB.open(IDB_NAME, 1)
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains('files')) {
        rq.result.createObjectStore('files')
      }
    }
    rq.onerror = () => reject(rq.error)
    rq.onsuccess = () => {
      const db = rq.result
      let tx: IDBTransaction
      try {
        tx = db.transaction('files', mode)
      } catch (err) {
        db.close()
        reject(err)
        return
      }
      const q = fn(tx.objectStore('files'))
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

export const idbPut = (id: string, blob: Blob): Promise<undefined> =>
  withDB('readwrite', (s) => s.put(blob, id) as unknown as IDBRequest<undefined>)

export const idbGet = (id: string): Promise<Blob | undefined> => withDB('readonly', (s) => s.get(id))

export const idbDelete = (id: string): Promise<undefined> =>
  withDB('readwrite', (s) => s.delete(id) as unknown as IDBRequest<undefined>).catch(() => undefined)

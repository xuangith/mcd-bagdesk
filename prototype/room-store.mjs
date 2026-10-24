import { mkdir, lstat, chmod, readFile, writeFile, readdir, rename, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const KEYS = [
  "schema", "id", "title", "store", "catalog", "joinHash", "version", "phase", "members",
  "locked", "plans", "confirmation", "attempt", "order", "desk", "deskVersion",
  "createdAt", "search", "review", "fulfillment",
];
const roomId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);

export class RoomStore {
  constructor(directory) { this.directory = directory; }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("餐桌数据目录不能是符号链接。");
    await chmod(this.directory, 0o700);
  }

  async write(room) {
    if (!roomId(room.id)) throw new Error("无效的餐桌编号。");
    const safe = Object.fromEntries(KEYS.filter((key) => room[key] !== undefined).map((key) => [key, room[key]]));
    const text = JSON.stringify(safe);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("餐桌记录超过存储上限。");
    const temporary = join(this.directory, `.${room.id}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx", flush: true });
      await rename(temporary, join(this.directory, `${room.id}.json`));
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      try { await unlink(temporary); } catch { /* 写盘失败时临时文件可能尚未创建。 */ }
      throw error;
    }
  }

  async readAll() {
    const files = (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    const rooms = [];
    for (const name of files) {
      const path = join(this.directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
        throw new Error("餐桌记录文件类型或大小异常。");
      }
      const room = JSON.parse(await readFile(path, "utf8"));
      if (!roomId(room.id) || name !== `${room.id}.json` || room.schema !== 1 ||
          !Number.isInteger(room.version) || !Array.isArray(room.members) || !room.catalog) {
        throw new Error("餐桌记录结构异常，未加载损坏数据。");
      }
      rooms.push(Object.fromEntries(KEYS.filter((key) => room[key] !== undefined).map((key) => [key, room[key]])));
    }
    return rooms;
  }
}

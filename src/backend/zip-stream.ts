/**
 * A streaming ZIP writer: entries are stored uncompressed and their sizes
 * and CRCs follow the data (a data descriptor), so nothing is buffered. The
 * classic format only, so the archive stays under 4 GB and 65535 entries.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

const LIMIT = 0xffffffff;

function dosDateTime(seconds: number): { time: number; date: number } {
  const d = new Date(Math.max(seconds, 315532800) * 1000);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  dir: boolean;
}

export class ZipWriter {
  private offset = 0;
  private entries: CentralEntry[] = [];

  constructor(private readonly write: (chunk: Buffer) => Promise<void>) {}

  private async emit(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (this.offset > LIMIT) {
      throw new Error("The archive would be larger than 4 GB");
    }
    await this.write(chunk);
  }

  private localHeader(name: Buffer, time: number, date: number, dir: boolean) {
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    // Bit 3: sizes follow the data. Bit 11: the name is UTF-8.
    head.writeUInt16LE(dir ? 0x0800 : 0x0808, 6);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt16LE(name.length, 26);
    return Buffer.concat([head, name]);
  }

  async addDirectory(path: string, mtime: number): Promise<void> {
    const name = Buffer.from(`${path.replace(/\/+$/, "")}/`);
    const { time, date } = dosDateTime(mtime);
    if (this.entries.length >= 0xfffe) throw new Error("Too many files");
    this.entries.push({
      name,
      crc: 0,
      size: 0,
      offset: this.offset,
      time,
      date,
      dir: true,
    });
    await this.emit(this.localHeader(name, time, date, true));
  }

  /**
   * Adds a file. `fill` calls `push` for each piece of its content, in
   * order, and resolves when it has pushed all of it.
   */
  async addFile(
    path: string,
    mtime: number,
    fill: (push: (chunk: Buffer) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const name = Buffer.from(path);
    const { time, date } = dosDateTime(mtime);
    if (this.entries.length >= 0xfffe) throw new Error("Too many files");
    const entry: CentralEntry = {
      name,
      crc: 0,
      size: 0,
      offset: this.offset,
      time,
      date,
      dir: false,
    };
    await this.emit(this.localHeader(name, time, date, false));
    await fill(async (chunk) => {
      entry.crc = crc32(chunk, entry.crc);
      entry.size += chunk.length;
      await this.emit(chunk);
    });
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(entry.size, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    await this.emit(descriptor);
    this.entries.push(entry);
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const entry of this.entries) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(entry.dir ? 0x0800 : 0x0808, 8);
      head.writeUInt16LE(entry.time, 12);
      head.writeUInt16LE(entry.date, 14);
      head.writeUInt32LE(entry.crc, 16);
      head.writeUInt32LE(entry.size, 20);
      head.writeUInt32LE(entry.size, 24);
      head.writeUInt16LE(entry.name.length, 28);
      if (entry.dir) head.writeUInt32LE(0x10, 38);
      head.writeUInt32LE(entry.offset, 42);
      await this.emit(Buffer.concat([head, entry.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.emit(end);
  }
}

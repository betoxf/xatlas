import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A desktop that registered with the relay; `passHash` is the shared HMAC key. */
export interface RelayDeviceRecord {
  readonly deviceSid: string;
  readonly deviceMid: string;
  readonly passHash: string;
  readonly registeredAt: number;
}

export interface RelayRegistry {
  get(deviceSid: string): Promise<RelayDeviceRecord | undefined>;
  /** Stores the record and revokes earlier registrations of the same desktop. */
  register(record: RelayDeviceRecord): Promise<void>;
}

const DEFAULT_MAX_DEVICES = 10_000;

export class MemoryRelayRegistry implements RelayRegistry {
  protected readonly records = new Map<string, RelayDeviceRecord>();

  constructor(private readonly maxDevices = DEFAULT_MAX_DEVICES) {}

  async get(deviceSid: string): Promise<RelayDeviceRecord | undefined> {
    return this.records.get(deviceSid);
  }

  async register(record: RelayDeviceRecord): Promise<void> {
    // A desktop re-registers when its pairing is reset; links built on the old sid must stop working.
    for (const [sid, existing] of this.records) {
      if (existing.deviceMid === record.deviceMid) this.records.delete(sid);
    }
    this.records.set(record.deviceSid, record);
    while (this.records.size > this.maxDevices) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}

/** Keeps registrations across restarts in a JSON file (mode 0600, written atomically). */
export class FileRelayRegistry extends MemoryRelayRegistry {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    maxDevices?: number,
  ) {
    super(maxDevices);
  }

  static async open(filePath: string, maxDevices?: number): Promise<FileRelayRegistry> {
    const registry = new FileRelayRegistry(filePath, maxDevices);
    try {
      const saved = JSON.parse(await readFile(filePath, "utf8")) as { devices?: RelayDeviceRecord[] };
      for (const record of saved.devices ?? []) registry.records.set(record.deviceSid, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return registry;
  }

  override async register(record: RelayDeviceRecord): Promise<void> {
    await super.register(record);
    const snapshot = JSON.stringify({ devices: [...this.records.values()] });
    // Writes run one at a time; a failed write doesn't block the ones after it.
    const write = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, this.filePath);
      });
    this.writing = write;
    await write;
  }
}

/**
 * Minimal Marionette client for Firefox 140 / Zotero 8.
 *
 * Wire protocol (https://firefox-source-docs.mozilla.org/testing/marionette/Protocol.html):
 *
 * - Messages are framed as `<length>:<json>` where `<length>` is the ASCII
 *   decimal byte length of the JSON payload, followed by `:`.
 * - Server's first message after TCP connect is a "hello" object containing
 *   `marionetteProtocol` and `applicationType`.
 * - Subsequent client messages are arrays: `[type, msgId, command, params]`.
 *   Type 0 is a request. The server replies with `[1, msgId, error, result]`
 *   where exactly one of `error` / `result` is non-null.
 */

import { Buffer } from "node:buffer";
import { connect } from "node:net";

const HELLO_TIMEOUT_MS = 15000;

export class MarionetteError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "MarionetteError";
    this.payload = payload;
  }
}

export class MarionetteClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextMessageId = 1;
    this.helloPromise = null;
    this.helloResolve = null;
    this.helloReject = null;
  }

  async connect(host, port, { timeoutMs } = {}) {
    if (this.socket) {
      throw new Error("MarionetteClient already connected");
    }
    const effectiveTimeout = timeoutMs ?? HELLO_TIMEOUT_MS;

    this.helloPromise = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        reject(err);
      };
      this.socket = connect({ host, port }, () => {
        this.socket.removeListener("error", onError);
        resolve();
      });
      // Attach data handler IMMEDIATELY so the hello frame is not dropped:
      // Marionette sends its hello as soon as the connection is accepted,
      // sometimes before the connect callback fires in Node.
      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._drainBuffer();
      });
      this.socket.on("error", (err) => {
        this._failAll(err);
      });
      this.socket.on("close", () => {
        this._failAll(new Error("Marionette connection closed"));
      });
      this.socket.once("error", onError);
    });

    const helloTimer = setTimeout(() => {
      const err = new Error(`Marionette hello not received within ${effectiveTimeout}ms`);
      if (this.helloReject) {
        this.helloReject(err);
      }
    }, effectiveTimeout);

    try {
      const hello = await this.helloPromise;
      return hello;
    } finally {
      clearTimeout(helloTimer);
    }
  }

  async newSession(capabilities = {}) {
    return this.send("WebDriver:NewSession", { capabilities });
  }

  async deleteSession() {
    return this.send("WebDriver:DeleteSession", {});
  }

  /**
   * Set the execution context. For Zotero we usually want "chrome" so we can
   * access `Zotero`, `Services`, the main window, etc.
   */
  async setContext(context) {
    return this.send("Marionette:SetContext", { value: context });
  }

  /**
   * Execute an async script in the current execution context. The script body
   * receives `resolve`/`reject` callbacks via the marionette-managed last
   * argument.
   */
  async executeAsyncScript(script, args = []) {
    return this.send("WebDriver:ExecuteAsyncScript", {
      script,
      args,
      newSandbox: false,
      scriptTimeout: 30000
    });
  }

  /**
   * Execute a synchronous script. The return value is the script's last
   * expression. Useful for fetching DOM properties or simple Zotero state.
   */
  async executeScript(script, args = []) {
    return this.send("WebDriver:ExecuteScript", {
      script,
      args,
      newSandbox: false
    });
  }

  async send(command, params) {
    if (!this.socket) {
      throw new Error("MarionetteClient is not connected");
    }
    const id = this.nextMessageId;
    this.nextMessageId += 1;
    const payload = [0, id, command, params ?? {}];
    const json = JSON.stringify(payload);
    const frame = `${Buffer.byteLength(json, "utf8")}:${json}`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(frame, "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close() {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  _drainBuffer() {
    while (this.buffer.length > 0) {
      const colon = this.buffer.indexOf(0x3a); // ':'
      if (colon < 0) {
        // No length prefix yet; wait for more data.
        return;
      }
      const lengthStr = this.buffer.slice(0, colon).toString("ascii");
      const length = Number.parseInt(lengthStr, 10);
      if (!Number.isFinite(length) || length < 0) {
        // Malformed frame; close.
        this._failAll(new Error(`Malformed Marionette frame length: ${lengthStr}`));
        this.close();
        return;
      }
      const start = colon + 1;
      const end = start + length;
      if (this.buffer.length < end) {
        return; // Wait for the rest of the frame.
      }
      const jsonText = this.buffer.slice(start, end).toString("utf8");
      this.buffer = this.buffer.slice(end);

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        this._failAll(new Error(`Marionette JSON parse error: ${err?.message ?? err}`));
        this.close();
        return;
      }

      if (Array.isArray(parsed)) {
        // Response frame: [1, msgId, error, result].
        const [, msgId, error, result] = parsed;
        const handler = this.pending.get(msgId);
        if (handler) {
          this.pending.delete(msgId);
          if (error != null) {
            handler.reject(
              new MarionetteError(error.message ?? "Marionette command failed", error)
            );
          } else {
            handler.resolve(result?.value !== undefined ? result.value : result);
          }
        }
      } else if (parsed && typeof parsed === "object") {
        // Hello frame.
        if (this.helloResolve) {
          this.helloResolve(parsed);
          this.helloResolve = null;
          this.helloReject = null;
        }
      }
    }
  }

  _failAll(err) {
    for (const [, handler] of this.pending) {
      handler.reject(err);
    }
    this.pending.clear();
    if (this.helloReject) {
      this.helloReject(err);
      this.helloResolve = null;
      this.helloReject = null;
    }
  }
}

export async function withMarionetteSession(host, port, fn, opts = {}) {
  const client = new MarionetteClient();
  try {
    await client.connect(host, port, opts);
    await client.newSession({});
    await client.setContext("chrome");
    return await fn(client);
  } finally {
    try {
      await client.deleteSession();
    } catch {
      /* ignore */
    }
    client.close();
  }
}

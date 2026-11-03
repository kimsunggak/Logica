/**
 * Incremental Server-Sent Events parser.
 *
 * Provider adapters feed raw text chunks (which may split events and lines at
 * arbitrary points) and receive complete events.
 */
export interface SSEEvent {
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer = "";
  private eventName: string | undefined;
  private dataLines: string[] = [];

  /** Feed a chunk; returns the events completed by it. */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      const sepLength = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (this.buffer[newline] === "\r" && newline + 1 === this.buffer.length) break;
      this.buffer = this.buffer.slice(newline + sepLength);
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** Flush a final event that was not followed by a blank line. */
  end(): SSEEvent[] {
    const events: SSEEvent[] = [];
    if (this.buffer) {
      const event = this.processLine(this.buffer);
      this.buffer = "";
      if (event) events.push(event);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SSEEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    return null;
  }

  private dispatch(): SSEEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      return null;
    }
    const event: SSEEvent = { event: this.eventName, data: this.dataLines.join("\n") };
    this.eventName = undefined;
    this.dataLines = [];
    return event;
  }
}

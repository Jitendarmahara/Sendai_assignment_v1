type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields }));
}

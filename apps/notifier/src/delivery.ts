import crypto from "node:crypto";
import type { AlertPayload } from "@pharos/shared";

export function sign(secret: string, timestamp: number, body: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${body}`);
  return "sha256=" + hmac.digest("hex");
}

export function backoffMs(
  attempt: number,
  baseS: number,
  random: () => number = Math.random
): number {
  const delayS = Math.min(baseS * Math.pow(2, attempt - 1), 3600);
  return Math.round(delayS * (0.8 + random() * 0.4) * 1000);
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export function telegramText(payload: AlertPayload): string {
  if (payload.event === "test") {
    return "✅ Pharos test notification: this channel works.";
  }

  const name = escapeHtml(payload.monitor?.name ?? "Monitor");
  const url = escapeHtml(payload.monitor?.url ?? "");
  const at = payload.at;

  if (payload.event === "incident_opened") {
    const cause = payload.cause ? escapeHtml(payload.cause) : "unknown";
    return `🔴 <b>${name}</b> is DOWN\n${url}\nCause: ${cause}\nSince: ${at}`;
  }

  if (payload.event === "degraded") {
    return `🟡 <b>${name}</b> is responding slowly\n${url}\nSince: ${at}`;
  }

  if (payload.event === "recovered") {
    let text = `🟢 <b>${name}</b> is back UP\n${url}`;
    if (
      payload.incident?.durationS !== null &&
      payload.incident?.durationS !== undefined
    ) {
      text += `\nDowntime: ${formatDuration(payload.incident.durationS)}`;
    }
    return text;
  }

  return `Notification for <b>${name}</b>: ${payload.event}`;
}

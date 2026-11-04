interface Env {
  ASSETS: Fetcher;
  OTP_SERVICE: DurableObjectNamespace;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  TURNSTILE_SECRET_KEY: string;
  OTP_HMAC_SECRET: string;
  OTP_TTL_SECONDS: string;
  OTP_COOLDOWN_SECONDS: string;
  OTP_MAX_ATTEMPTS: string;
  OTP_MAX_SENDS_PER_HOUR: string;
  OTP_MAX_SENDS_PER_MONTH: string;
  DEMO_MODE: string;
  TURNSTILE_SITE_KEY: string;
  ALLOWED_ORIGIN: string;
  DASHBOARD_USERNAME?: string;
  DASHBOARD_PASSWORD?: string;
}

interface OtpRecord {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

interface SendReservation {
  allowed: boolean;
  retryAfter?: number;
}

interface MonthlyUsage {
  month: string;
  count: number;
}

type SendStatus = "sending" | "accepted" | "failed" | "demo";

interface SendHistoryRecord {
  id: string;
  phoneNumber: string;
  createdAt: string;
  updatedAt: string;
  status: SendStatus;
}

const phonePattern = /^\+62[1-9]\d{7,11}$/;
const codePattern = /^\d{6}$/;
const hourMilliseconds = 60 * 60 * 1000;
const maxHistoryEntries = 500;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hashCode(code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code)));
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function generateCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= limit);
  return String(random[0] % 1_000_000).padStart(6, "0");
}

function isDashboardAuthorized(request: Request, env: Env): boolean {
  const username = env.DASHBOARD_USERNAME;
  const password = env.DASHBOARD_PASSWORD;
  if (!username || !password) return false;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;

  try {
    const bytes = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
    return constantTimeEqual(new TextDecoder().decode(bytes), `${username}:${password}`);
  } catch {
    return false;
  }
}

async function verifyTurnstile(token: string, secret: string, ip?: string): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Turnstile verification returned HTTP ${response.status}`);
  }
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("vary", "Origin");
  }
  return headers;
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const headers = corsHeaders(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (new URL(request.url).pathname === "/api/config" && request.method === "GET") {
    return jsonResponse({
      demoMode: env.DEMO_MODE === "true",
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    }, 200, headers);
  }
  if (new URL(request.url).pathname === "/api/dashboard/sends" && request.method === "GET") {
    if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
      console.error("Dashboard credentials are not configured");
      return jsonResponse({ error: "Dashboard is not configured" }, 503, headers);
    }
    if (!isDashboardAuthorized(request, env)) {
      return jsonResponse({ error: "Login tidak valid" }, 401, headers);
    }

    const objectId = env.OTP_SERVICE.idFromName("monthly-sms-quota");
    const stub = env.OTP_SERVICE.get(objectId);
    const response = await stub.fetch("https://otp-service/internal/history", {
      method: "GET",
    });
    if (!response.ok) {
      console.error("Dashboard history request failed", response.status);
      return jsonResponse({ error: "Could not load send history" }, 502, headers);
    }
    const history = await response.json();
    const responseHeaders = new Headers(headers);
    responseHeaders.set("cache-control", "no-store");
    return jsonResponse(history, 200, responseHeaders);
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, headers);
  }

  const path = new URL(request.url).pathname;
  if (path !== "/api/otp/send" && path !== "/api/otp/verify") {
    return jsonResponse({ error: "Not found" }, 404, headers);
  }
  if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
    console.error("Dashboard credentials are not configured");
    return jsonResponse({ error: "Dashboard is not configured" }, 503, headers);
  }
  if (!isDashboardAuthorized(request, env)) {
    return jsonResponse({ error: "Login tidak valid" }, 401, headers);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return jsonResponse({ error: "Request body must be a JSON object" }, 400, headers);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400, headers);
  }

  const phoneNumber = body.phoneNumber;
  if (typeof phoneNumber !== "string" || !phonePattern.test(phoneNumber)) {
    return jsonResponse(
      { error: "phoneNumber must be an Indonesian number in E.164 format, such as +6281234567890" },
      400,
      headers,
    );
  }

  if (path === "/api/otp/send" && env.DEMO_MODE !== "true") {
    const turnstileToken = body.turnstileToken;
    if (typeof turnstileToken !== "string" || turnstileToken.length === 0) {
      return jsonResponse({ error: "turnstileToken is required" }, 400, headers);
    }
    const ip = request.headers.get("cf-connecting-ip") ?? undefined;
    let turnstileValid: boolean;
    try {
      turnstileValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
    } catch (error) {
      console.error("Turnstile verification failed", error);
      return jsonResponse({ error: "Could not verify anti-abuse challenge" }, 502, headers);
    }
    if (!turnstileValid) {
      return jsonResponse({ error: "Anti-abuse challenge failed" }, 403, headers);
    }
  }

  if (path === "/api/otp/verify") {
    const code = body.code;
    if (typeof code !== "string" || !codePattern.test(code)) {
      return jsonResponse({ error: "code must contain exactly 6 digits" }, 400, headers);
    }
  }

  try {
    const phoneHash = await sha256(phoneNumber);
    const objectId = env.OTP_SERVICE.idFromName(phoneHash);
    const stub = env.OTP_SERVICE.get(objectId);
    const serviceResponse = await stub.fetch(`https://otp-service${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        path === "/api/otp/send"
          ? { phoneNumber }
          : { code: body.code },
      ),
    });
    const payload = await serviceResponse.json();
    return jsonResponse(payload, serviceResponse.status, headers);
  } catch (error) {
    console.error("OTP request failed", error);
    return jsonResponse({ error: "Internal server error" }, 500, headers);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET") {
        return Response.redirect(new URL("/login", url), 302);
      }
      if (url.pathname === "/dashboard" && request.method === "GET") {
        return Response.redirect(new URL("/login", url), 302);
      }
      if (url.pathname === "/login" && request.method === "GET") {
        return await env.ASSETS.fetch(request);
      }
      if (!url.pathname.startsWith("/api/")) {
        return await env.ASSETS.fetch(request);
      }
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Worker configuration or request failure", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },
};

export class OtpService implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/internal/history" && request.method === "GET") {
        return jsonResponse({ sends: await this.getHistory() });
      }
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      if (path === "/api/otp/send") {
        const { phoneNumber } = (await request.json()) as { phoneNumber?: unknown };
        if (typeof phoneNumber !== "string") {
          return jsonResponse({ error: "Invalid request" }, 400);
        }
        return await this.send(phoneNumber);
      }
      if (path === "/internal/quota/reserve") {
        return await this.reserveMonthlySend();
      }
      if (path === "/internal/history") {
        const { id, phoneNumber, status } = (await request.json()) as {
          id?: unknown;
          phoneNumber?: unknown;
          status?: unknown;
        };
        if (
          typeof id !== "string" ||
          (phoneNumber !== undefined && typeof phoneNumber !== "string") ||
          !this.isSendStatus(status)
        ) {
          return jsonResponse({ error: "Invalid request" }, 400);
        }
        return await this.recordHistory(id, phoneNumber, status);
      }
      if (path === "/api/otp/verify") {
        const { code } = (await request.json()) as { code?: unknown };
        if (typeof code !== "string" || !codePattern.test(code)) {
          return jsonResponse({ error: "Invalid request" }, 400);
        }
        return await this.verify(code);
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.error("OTP service operation failed", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  }

  private async send(phoneNumber: string): Promise<Response> {
    const now = Date.now();
    const cooldownSeconds = positiveInteger(
      this.env.OTP_COOLDOWN_SECONDS,
      "OTP_COOLDOWN_SECONDS",
    );
    const maxSends = positiveInteger(
      this.env.OTP_MAX_SENDS_PER_HOUR,
      "OTP_MAX_SENDS_PER_HOUR",
    );

    const reservation = await this.state.storage.transaction<SendReservation>(
      async (transaction) => {
        const sendTimes = (await transaction.get<number[]>("sendTimes")) ?? [];
        const recentSends = sendTimes.filter((time) => now - time < hourMilliseconds);
        const lastSentAt = recentSends.at(-1);
        if (lastSentAt !== undefined && now - lastSentAt < cooldownSeconds * 1000) {
          return {
            allowed: false,
            retryAfter: Math.ceil((cooldownSeconds * 1000 - (now - lastSentAt)) / 1000),
          };
        }
        if (recentSends.length >= maxSends) {
          const oldest = recentSends[0];
          return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil((hourMilliseconds - (now - oldest)) / 1000)),
          };
        }
        recentSends.push(now);
        await transaction.put("sendTimes", recentSends);
        return { allowed: true };
      },
    );

    if (!reservation.allowed) {
      return jsonResponse(
        { error: "Too many requests. Please try again later." },
        429,
        { "retry-after": String(reservation.retryAfter ?? cooldownSeconds) },
      );
    }

    const code = generateCode();
    const expiresAt = now + positiveInteger(this.env.OTP_TTL_SECONDS, "OTP_TTL_SECONDS") * 1000;
    const secret = this.env.OTP_HMAC_SECRET || (this.env.DEMO_MODE === "true" ? "demo-mode-only" : "");
    const codeHash = await hashCode(code, secret);
    if (this.env.DEMO_MODE === "true") {
      await this.state.storage.put<OtpRecord>("otp", {
        codeHash,
        expiresAt,
        attempts: 0,
      });
      await this.writeSendHistory(crypto.randomUUID(), phoneNumber, "demo");
      return jsonResponse({
        message: "Demo mode: no SMS was sent.",
        demoCode: code,
      }, 202);
    }

    const quotaId = this.env.OTP_SERVICE.idFromName("monthly-sms-quota");
    const quota = this.env.OTP_SERVICE.get(quotaId);
    const quotaResponse = await quota.fetch("https://otp-service/internal/quota/reserve", {
      method: "POST",
    });
    if (!quotaResponse.ok) {
      console.error("Monthly SMS quota reservation failed", quotaResponse.status);
      return jsonResponse({ error: "Could not check monthly SMS quota" }, 502);
    }
    const quotaResult = (await quotaResponse.json()) as { allowed: boolean };
    if (!quotaResult.allowed) {
      return jsonResponse(
        { error: "Monthly SMS quota reached. Please try again next month." },
        429,
      );
    }

    const sendId = crypto.randomUUID();
    await this.writeSendHistory(sendId, phoneNumber, "sending");

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      this.env.TWILIO_ACCOUNT_SID,
    )}/Messages.json`;
    const credentials = btoa(
      `${this.env.TWILIO_ACCOUNT_SID}:${this.env.TWILIO_AUTH_TOKEN}`,
    );
    const message = new URLSearchParams({
      To: phoneNumber,
      From: this.env.TWILIO_FROM_NUMBER,
      Body: `Your verification code is ${code}. It expires in ${Math.ceil(
        (expiresAt - now) / 60_000,
      )} minutes.`,
    });

    let smsResponse: Response;
    try {
      smsResponse = await fetch(twilioUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: message,
      });
    } catch (error) {
      console.error("Twilio request failed", error);
      await this.updateSendHistory(sendId, phoneNumber, "failed");
      return jsonResponse({ error: "Could not send SMS" }, 502);
    }
    if (!smsResponse.ok) {
      console.error("Twilio rejected SMS request", smsResponse.status);
      await this.updateSendHistory(sendId, phoneNumber, "failed");
      return jsonResponse({ error: "Could not send SMS" }, 502);
    }

    await this.state.storage.put<OtpRecord>("otp", {
      codeHash,
      expiresAt,
      attempts: 0,
    });
    await this.updateSendHistory(sendId, phoneNumber, "accepted");
    return jsonResponse({ message: "If the number is eligible, a verification code was sent." }, 202);
  }

  private async verify(code: string): Promise<Response> {
    const secret = this.env.OTP_HMAC_SECRET || (this.env.DEMO_MODE === "true" ? "demo-mode-only" : "");
    const submittedHash = await hashCode(code, secret);
    const result = await this.state.storage.transaction(async (transaction) => {
      const record = await transaction.get<OtpRecord>("otp");
      if (!record || record.expiresAt <= Date.now() || record.attempts >= this.maxAttempts()) {
        await transaction.delete("otp");
        return "invalid";
      }
      if (!constantTimeEqual(record.codeHash, submittedHash)) {
        record.attempts += 1;
        if (record.attempts >= this.maxAttempts()) {
          await transaction.delete("otp");
        } else {
          await transaction.put("otp", record);
        }
        return "invalid";
      }
      await transaction.delete("otp");
      return "verified";
    });

    if (result !== "verified") {
      return jsonResponse({ verified: false, error: "Invalid or expired code" }, 400);
    }
    return jsonResponse({ verified: true });
  }

  private maxAttempts(): number {
    return positiveInteger(this.env.OTP_MAX_ATTEMPTS, "OTP_MAX_ATTEMPTS");
  }

  private async reserveMonthlySend(): Promise<Response> {
    const month = new Date().toISOString().slice(0, 7);
    const maxSends = positiveInteger(
      this.env.OTP_MAX_SENDS_PER_MONTH,
      "OTP_MAX_SENDS_PER_MONTH",
    );
    const allowed = await this.state.storage.transaction(async (transaction) => {
      const usage = await transaction.get<MonthlyUsage>("monthlyUsage");
      const currentUsage = usage?.month === month ? usage : { month, count: 0 };
      if (currentUsage.count >= maxSends) {
        return false;
      }
      currentUsage.count += 1;
      await transaction.put("monthlyUsage", currentUsage);
      return true;
    });
    return jsonResponse({ allowed });
  }

  private isSendStatus(value: unknown): value is SendStatus {
    return value === "sending" || value === "accepted" || value === "failed" || value === "demo";
  }

  private async getHistory(): Promise<SendHistoryRecord[]> {
    return (await this.state.storage.get<SendHistoryRecord[]>("sendHistory")) ?? [];
  }

  private async recordHistory(
    id: string,
    phoneNumber: string | undefined,
    status: SendStatus,
  ): Promise<Response> {
    const updatedAt = new Date().toISOString();
    const sends = await this.state.storage.transaction(async (transaction) => {
      const history = (await transaction.get<SendHistoryRecord[]>("sendHistory")) ?? [];
      const existing = history.find((send) => send.id === id);
      if (existing) {
        existing.status = status;
        existing.updatedAt = updatedAt;
      } else {
        if (typeof phoneNumber !== "string" || !phonePattern.test(phoneNumber)) {
          return null;
        }
        history.unshift({
          id,
          phoneNumber: `${phoneNumber.slice(0, 6)}••••${phoneNumber.slice(-4)}`,
          createdAt: updatedAt,
          updatedAt,
          status,
        });
      }
      await transaction.put("sendHistory", history.slice(0, maxHistoryEntries));
      return history.slice(0, maxHistoryEntries);
    });
    if (!sends) {
      return jsonResponse({ error: "Invalid phone number" }, 400);
    }
    return jsonResponse({ recorded: true });
  }

  private async writeSendHistory(
    id: string,
    phoneNumber: string,
    status: SendStatus,
  ): Promise<void> {
    const response = await this.updateSendHistory(id, phoneNumber, status);
    if (!response.ok) {
      throw new Error(`Could not record send history: HTTP ${response.status}`);
    }
  }

  private async updateSendHistory(
    id: string,
    phoneNumber: string | undefined,
    status: SendStatus,
  ): Promise<Response> {
    const objectId = this.env.OTP_SERVICE.idFromName("monthly-sms-quota");
    const historyService = this.env.OTP_SERVICE.get(objectId);
    try {
      const response = await historyService.fetch("https://otp-service/internal/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, phoneNumber, status }),
      });
      if (!response.ok) {
        console.error("Could not update OTP send history", response.status);
      }
      return response;
    } catch (error) {
      console.error("Could not update OTP send history", error);
      throw error;
    }
  }
}

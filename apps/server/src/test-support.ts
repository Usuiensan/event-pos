import type { FastifyInstance } from "fastify";

export async function openRegisterForTest(app: FastifyInstance, eventId: string, businessDate: string, registerId: string): Promise<string> {
  let response = await app.inject({ method: "GET", url: `/api/v1/business-sessions/current?eventId=${encodeURIComponent(eventId)}` });
  let business = response.statusCode === 200 ? response.json().session as { businessSessionId: string } | null : null;
  if (!business) {
    response = await app.inject({ method: "POST", url: "/api/v1/business-sessions", payload: { eventId, businessDate, terminalId: registerId } });
    if (response.statusCode !== 201) throw new Error(`test business open failed: ${response.body}`);
    business = response.json();
  }
  response = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${encodeURIComponent(business!.businessSessionId)}/registers/${encodeURIComponent(registerId)}/prepare`, payload: { terminalId: registerId } });
  if (response.statusCode !== 201) throw new Error(`test register prepare failed: ${response.body}`);
  const sessionId = response.json().sessionId as string;
  const current = await app.inject({ method: "GET", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}` });
  if (current.json().state === "preparing") {
    const opened = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/opening`, headers: { "idempotency-key": `test-opening:${sessionId}` }, payload: { counted: [], terminalId: registerId } });
    if (opened.statusCode !== 201) throw new Error(`test register opening failed: ${opened.body}`);
  }
  return sessionId;
}

export async function signInForTest(app: FastifyInstance, input: { eventId: string; responsibleNumber: string; terminalId: string }): Promise<Record<string, string>> {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/sessions", payload: input });
  if (response.statusCode !== 201) throw new Error(`test sign in failed: ${response.body}`);
  const setCookie = response.headers["set-cookie"]; const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  if (!cookie) throw new Error("test sign in cookie missing");
  return { cookie, "x-csrf-token": response.json().actor.csrfToken as string };
}

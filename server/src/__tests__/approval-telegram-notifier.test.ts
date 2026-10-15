// Aspireco: approval alerts on Telegram.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb } from "@paperclipai/db";
import { approvalTelegramMessage, approvalTelegramNotifier } from "../services/approval-telegram-notifier.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function fakeTelegram(ok = true) {
  const sent: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe("approvalTelegramMessage", () => {
  it("names the company and title, trims the summary, and links straight to the approval", () => {
    const text = approvalTelegramMessage({
      approvalId: "ap-1",
      companyName: "Aspireco",
      issuePrefix: "ASP",
      payload: { title: "Approve high-risk tool action: mail-send", summary: "x".repeat(500) },
      publicBaseUrl: "https://hq.example/",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Approval needed - Aspireco");
    expect(lines[1]).toBe("Approve high-risk tool action: mail-send");
    expect(lines[2].length).toBe(300);
    expect(lines[3]).toBe("Open: https://hq.example/ASP/approvals/ap-1");
  });
});

describeDb("approvalTelegramNotifier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-telegram-");
    db = createDb(tempDb.connectionString);
  }, 300_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company() {
    const [row] = await db.insert(companies).values({ name: "Aspireco", issuePrefix: `A${randomUUID().slice(0, 5).toUpperCase()}` }).returning();
    companyId = row.id;
    return row;
  }

  async function approval(title: string, status = "pending", createdAt = new Date()) {
    const [row] = await db.insert(approvals).values({
      companyId, type: "request_board_approval", status, payload: { title }, createdAt, updatedAt: createdAt,
    }).returning();
    return row;
  }

  it("stays off without a token and chat id", async () => {
    const telegram = fakeTelegram();
    const notifier = approvalTelegramNotifier(db, { fetchImpl: telegram.fetchImpl });
    expect(notifier.enabled).toBe(false);
    expect(await notifier.sweep()).toEqual({ sent: 0 });
    expect(telegram.sent).toHaveLength(0);
  });

  it("alerts once per new approval, to the configured chat, with a link", async () => {
    const co = await company();
    const telegram = fakeTelegram();
    const notifier = approvalTelegramNotifier(db, {
      botToken: "123:abc", chatId: "8690378276", publicBaseUrl: "https://hq.example", fetchImpl: telegram.fetchImpl,
    });
    await notifier.sweep();
    const first = await approval("Send the test email");

    expect(await notifier.sweep()).toEqual({ sent: 1 });
    expect(await notifier.sweep()).toEqual({ sent: 0 });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(telegram.sent[0].body.chat_id).toBe("8690378276");
    expect(telegram.sent[0].body.text).toContain("Send the test email");
    expect(telegram.sent[0].body.text).toContain(`https://hq.example/${co.issuePrefix}/approvals/${first.id}`);
  });

  it("ignores decided approvals", async () => {
    await company();
    const telegram = fakeTelegram();
    const notifier = approvalTelegramNotifier(db, { botToken: "123:abc", chatId: "1", fetchImpl: telegram.fetchImpl });
    await notifier.sweep();
    await approval("Already approved", "approved");
    await approval("Already rejected", "rejected");

    expect(await notifier.sweep()).toEqual({ sent: 0 });
    expect(telegram.sent).toHaveLength(0);
  });

  it("after a restart, one catch-up line covers what was already waiting", async () => {
    await company();
    await approval("Old one", "pending", new Date(Date.now() - 60_000));
    await approval("Older one", "pending", new Date(Date.now() - 120_000));
    const telegram = fakeTelegram();
    const notifier = approvalTelegramNotifier(db, {
      botToken: "123:abc", chatId: "1", publicBaseUrl: "https://hq.example", fetchImpl: telegram.fetchImpl,
    });

    expect(await notifier.sweep()).toEqual({ sent: 1 });
    expect(await notifier.sweep()).toEqual({ sent: 0 });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].body.text).toBe("2 approvals are waiting in Paperclip: https://hq.example");
  });

  it("with the endpoint bot, alerts carry Approve/Reject buttons; if that bot cannot send, the plain bot is used without buttons", async () => {
    await company();
    const viaEndpoint: Array<Record<string, unknown>> = [];
    let endpointUp = true;
    const telegram = fakeTelegram();
    const notifier = approvalTelegramNotifier(db, {
      sendViaEndpoint: async (body) => { viaEndpoint.push(body); return endpointUp; },
      buttonsFor: (id) => ({ inline_keyboard: [[{ text: "✅ Approve", callback_data: `y${id}` }]] }),
      botToken: "123:abc", chatId: "1", fetchImpl: telegram.fetchImpl,
    });
    await notifier.sweep();
    const first = await approval("With buttons");
    expect(await notifier.sweep()).toEqual({ sent: 1 });
    expect(viaEndpoint[0].reply_markup).toEqual({ inline_keyboard: [[{ text: "✅ Approve", callback_data: `y${first.id}` }]] });
    expect(telegram.sent).toHaveLength(0);

    endpointUp = false;
    await approval("Endpoint down");
    expect(await notifier.sweep()).toEqual({ sent: 1 });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].body).not.toHaveProperty("reply_markup");
    expect(telegram.sent[0].body.text).toContain("Endpoint down");
  });

  // Aspireco 2026-10-15: an alert sent before a restart may have gone out through the plain bot (no
  // buttons), so with the endpoint bot whatever is still waiting is re-sent, each with its own buttons.
  it("with the endpoint bot, approvals already waiting at a restart are re-sent one by one with their buttons", async () => {
    await company();
    const waiting = await approval("Waiting since before the restart", "pending", new Date(Date.now() - 60_000));
    const viaEndpoint: Array<Record<string, unknown>> = [];
    const telegram = fakeTelegram();
    const notifier = approvalTelegramNotifier(db, {
      sendViaEndpoint: async (body) => { viaEndpoint.push(body); return true; },
      buttonsFor: (id) => ({ inline_keyboard: [[{ text: "✅ Approve", callback_data: `y${id}` }]] }),
      botToken: "123:abc", chatId: "1", fetchImpl: telegram.fetchImpl,
    });

    expect(await notifier.sweep()).toEqual({ sent: 1 });
    expect(await notifier.sweep()).toEqual({ sent: 0 });
    expect(viaEndpoint).toHaveLength(1);
    expect(String(viaEndpoint[0].text)).toContain("Waiting since before the restart");
    expect(viaEndpoint[0].reply_markup).toEqual({ inline_keyboard: [[{ text: "✅ Approve", callback_data: `y${waiting.id}` }]] });
    expect(telegram.sent).toHaveLength(0);
  });

  it("a failed send is retried on the next sweep, not dropped", async () => {
    await company();
    let ok = false;
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).text);
      return new Response("{}", { status: ok ? 200 : 502 });
    }) as unknown as typeof fetch;
    const notifier = approvalTelegramNotifier(db, { botToken: "123:abc", chatId: "1", fetchImpl });
    await notifier.sweep();
    await approval("Retry me");

    expect(await notifier.sweep()).toEqual({ sent: 0 });
    ok = true;
    expect(await notifier.sweep()).toEqual({ sent: 1 });
    expect(sent.filter((text) => text.includes("Retry me"))).toHaveLength(2);
  });
});

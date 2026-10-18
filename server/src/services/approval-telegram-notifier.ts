// Aspireco: tell the board on Telegram when something waits for its approval. Paperclip has no
// approval notifications of its own (upstream #5600), so a held send could sit unseen for hours.
// Runs on the heartbeat scheduler; off unless both PAPERCLIP_APPROVAL_TELEGRAM_BOT_TOKEN and
// PAPERCLIP_APPROVAL_TELEGRAM_CHAT_ID are set. Best effort: a failed send is retried next sweep.
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { approvals, companies, type Db } from "@paperclipai/db";

const OPEN = ["pending", "revision_requested"] as const;
const MAX_PER_SWEEP = 20;

type Options = {
  /** Send through a Paperclip Telegram endpoint's own bot (needed for buttons: taps reach Paperclip). */
  sendViaEndpoint?: ((body: Record<string, unknown>) => Promise<boolean>) | null;
  /** Inline keyboard for an approval (endpoint mode only). */
  buttonsFor?: ((approvalId: string) => Record<string, unknown> | null) | null;
  botToken?: string | null;
  chatId?: string | null;
  publicBaseUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Hermes sends its own short card per approval (Task 2); skip the plain alert once one exists. */
  hasCard?: (approvalId: string) => boolean;
  /** How long to wait for a card before falling back to the plain alert. Default 10 minutes. */
  cardGraceMs?: number;
  /** The `companyId:tool` pairs Hermes cards (PAPERCLIP_CARDED_TOOLS, see parseCardedTools). Only
   * these wait out the card grace; every other approval alerts at once. Empty or unset: no grace. */
  cardedTools?: ReadonlySet<string> | null;
};

/** Aspireco: PAPERCLIP_CARDED_TOOLS, comma-separated `companyId:tool`, into the set of approvals
 * Hermes sends a card for. Blank or malformed entries are ignored. */
export function parseCardedTools(raw: string | null | undefined): Set<string> {
  const pairs = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const at = entry.indexOf(":");
    const companyId = entry.slice(0, at).trim().toLowerCase();
    const tool = entry.slice(at + 1).trim();
    if (at > 0 && companyId && tool) pairs.add(`${companyId}:${tool}`);
  }
  return pairs;
}

/** The fallback alert's extra line for an approval that should have had a card. */
export const CARD_MISSED_LINE = "The full card didn't arrive — open the board to see what you're approving.";

function clip(text: unknown, max: number): string {
  const value = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function approvalTelegramMessage(input: {
  approvalId: string;
  companyName: string;
  issuePrefix: string;
  payload: unknown;
  publicBaseUrl: string | null;
  /** This approval should have had a Hermes card and none came: say so, so it isn't approved blind. */
  cardMissed?: boolean;
}): string {
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const title = clip(payload.title, 160) || "An approval is waiting";
  const summary = clip(payload.summary, 300);
  const link = input.publicBaseUrl
    ? `${input.publicBaseUrl.replace(/\/+$/, "")}/${input.issuePrefix}/approvals/${input.approvalId}`
    : null;
  return [
    `Approval needed - ${input.companyName}`,
    title,
    summary,
    input.cardMissed ? CARD_MISSED_LINE : "",
    link ? `Open: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function approvalTelegramNotifier(db: Db, options: Options = {}) {
  const botToken = options.botToken?.trim() || null;
  const chatId = options.chatId?.trim() || null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const viaEndpoint = options.sendViaEndpoint ?? null;
  const enabled = Boolean((viaEndpoint || botToken) && chatId);
  // With buttons, approvals already waiting at startup are re-sent one by one: an alert sent before the
  // restart may have gone out through the plain bot without them (Aspireco 2026-10-15).
  const withButtons = Boolean(viaEndpoint && options.buttonsFor);
  const startedAt = now();
  const notified = new Set<string>();
  let catchUpDone = withButtons;
  const cardedTools = options.cardedTools ?? null;

  function isCarded(companyId: string, payload: unknown): boolean {
    const tool = (payload as { tool?: unknown } | null)?.tool;
    return Boolean(cardedTools?.size && typeof tool === "string" && cardedTools.has(`${companyId.toLowerCase()}:${tool}`));
  }

  async function send(text: string, approvalId?: string): Promise<boolean> {
    const markup = approvalId && viaEndpoint ? options.buttonsFor?.(approvalId) ?? null : null;
    const body = { chat_id: chatId, text, disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) };
    if (viaEndpoint) {
      try {
        if (await viaEndpoint(body)) return true;
      } catch {
        // fall through to the plain bot
      }
      if (!botToken) return false;
    }
    // The plain bot's chat has no Paperclip webhook, so its alerts never carry buttons.
    const { reply_markup: _buttons, ...plain } = body as typeof body & { reply_markup?: unknown };
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plain),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    enabled,
    async sweep(): Promise<{ sent: number }> {
      if (!enabled) return { sent: 0 };
      let sent = 0;

      if (!catchUpDone) {
        // After a restart, one line for whatever was already waiting, instead of a burst.
        const waiting = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(and(inArray(approvals.status, [...OPEN]), lt(approvals.createdAt, startedAt)));
        if (waiting.length === 0 || (await send(
          `${waiting.length} approval${waiting.length === 1 ? " is" : "s are"} waiting in Paperclip${
            options.publicBaseUrl ? `: ${options.publicBaseUrl.replace(/\/+$/, "")}` : ""}`,
        ))) {
          catchUpDone = true;
          if (waiting.length) sent += 1;
        }
      }

      const fresh = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          payload: approvals.payload,
          companyName: companies.name,
          issuePrefix: companies.issuePrefix,
          createdAt: approvals.createdAt,
        })
        .from(approvals)
        .innerJoin(companies, eq(companies.id, approvals.companyId))
        .where(and(inArray(approvals.status, [...OPEN]), withButtons ? undefined : gte(approvals.createdAt, startedAt)))
        .orderBy(asc(approvals.createdAt))
        .limit(MAX_PER_SWEEP + notified.size);

      for (const row of fresh) {
        if (notified.has(row.id) || sent >= MAX_PER_SWEEP) continue;
        // A Hermes card already covers this approval; never double-alert it.
        if (options.hasCard?.(row.id)) {
          notified.add(row.id);
          continue;
        }
        // No card yet: if Hermes cards this company's tool, give it a grace window before falling
        // back to the plain alert; anything Hermes doesn't card alerts at once. Age is measured
        // with this process's own clock against the DB's createdAt, so clock skew only shifts when
        // the fallback fires - it never suppresses it.
        const carded = Boolean(options.hasCard) && isCarded(row.companyId, row.payload);
        const graceMs = options.cardGraceMs ?? 600_000;
        if (carded && now().getTime() - new Date(row.createdAt).getTime() < graceMs) continue;
        const ok = await send(approvalTelegramMessage({
          approvalId: row.id,
          companyName: row.companyName,
          issuePrefix: row.issuePrefix,
          payload: row.payload,
          publicBaseUrl: options.publicBaseUrl ?? null,
          cardMissed: carded,
        }), row.id);
        if (ok) {
          notified.add(row.id);
          sent += 1;
        }
      }
      return { sent };
    },
  };
}

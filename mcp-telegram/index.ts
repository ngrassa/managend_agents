import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!;
const DEFAULT_CHAT = process.env.TELEGRAM_CHAT_ID!;
const API_BASE   = `https://api.telegram.org/bot${BOT_TOKEN}`;

const server = new Server(
  { name: "telegram-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "telegram_alert_critical",
      description: "Envoie une alerte critique de sécurité sur Telegram (message formaté Markdown)",
      inputSchema: {
        type: "object" as const,
        properties: {
          namespace: { type: "string", description: "Namespace K8s concerné" },
          severity:  { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM"], description: "Niveau de sévérité" },
          cve_list:  { type: "array", items: { type: "string" }, description: "Liste des CVE IDs" },
          image:     { type: "string", description: "Image Docker concernée" },
          remediation: { type: "string", description: "Action corrective recommandée" },
          chat_id:   { type: "string", description: "Chat ID Telegram (optionnel)" },
        },
        required: ["namespace", "severity", "cve_list", "image", "remediation"],
      },
    },
    {
      name: "telegram_send_report",
      description: "Envoie le rapport de sécurité complet sur Telegram",
      inputSchema: {
        type: "object" as const,
        properties: {
          report_content: { type: "string", description: "Contenu Markdown du rapport" },
          title:  { type: "string", description: "Titre du rapport" },
          score:  { type: "number", description: "Score de sécurité 0-100" },
          chat_id: { type: "string" },
        },
        required: ["report_content", "title", "score"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const chatId = (args.chat_id as string) || DEFAULT_CHAT;

  const send = async (text: string, parseMode = "HTML") => {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
    });
    return res.json() as any;
  };

  if (name === "telegram_alert_critical") {
    const severity = args.severity as string;
    const emoji    = severity === "CRITICAL" ? "🔴" : severity === "HIGH" ? "🟠" : "🟡";
    const cves     = (args.cve_list as string[]).map(c => `• <code>${c}</code>`).join("\n");

    const text = [
      `${emoji} <b>Alerte DevSecOps — ${severity}</b>`,
      ``,
      `<b>Namespace :</b> <code>${args.namespace}</code>`,
      `<b>Image     :</b> <code>${args.image}</code>`,
      ``,
      `<b>CVEs détectés :</b>`,
      cves,
      ``,
      `<b>Remédiation :</b>`,
      `<pre>${args.remediation}</pre>`,
      ``,
      `<i>Scan automatique — ${new Date().toISOString()}</i>`,
    ].join("\n");

    const result = await send(text);
    return {
      content: [{ type: "text" as const, text: result.ok ? `✅ Alerte envoyée (msg_id: ${result.result?.message_id})` : `❌ Erreur Telegram: ${result.description}` }],
    };
  }

  if (name === "telegram_send_report") {
    const score      = args.score as number;
    const scoreEmoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";
    const excerpt    = (args.report_content as string).slice(0, 3500);

    const text = [
      `${scoreEmoji} <b>${args.title}</b>`,
      `<b>Score de sécurité :</b> ${score}/100`,
      ``,
      `<pre>${excerpt}</pre>`,
    ].join("\n");

    const result = await send(text);
    return {
      content: [{ type: "text" as const, text: result.ok ? `✅ Rapport envoyé` : `❌ Erreur: ${result.description}` }],
    };
  }

  return { content: [{ type: "text" as const, text: "Outil inconnu" }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

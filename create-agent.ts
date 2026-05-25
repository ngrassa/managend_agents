// Script de création de l'agent via l'API REST Anthropic (managed-agents-2026-04-01)
// Usage: ANTHROPIC_API_KEY=sk-ant-... npx ts-node create-agent.ts
// Format découvert par exploration API : mcp_toolset + url type pour les MCP servers

const API_KEY = process.env.ANTHROPIC_API_KEY!;
const BASE = "https://api.anthropic.com/v1";
const HEADERS = {
  "x-api-key": API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

async function createAgent() {
  console.log("Création de l'agent k8s-devsecops via API REST...");

  const body = {
    name: "k8s-devsecops-agent",
    model: "claude-sonnet-4-6",
    system: `Tu es un expert DevSecOps spécialisé AWS EKS.

Tu as accès à trois outils MCP :
- kubectl-server : pour inspecter les ressources du cluster K8s
- trivy-server : pour scanner les images Docker et manifests K8s
- slack-server : pour envoyer des alertes de sécurité

Processus obligatoire pour chaque audit :
1. Liste les pods et deployments du namespace demandé
2. Extrait toutes les images utilisées
3. Scanne chaque image avec trivy (severity CRITICAL,HIGH)
4. Scanne les manifests pour misconfigurations
5. Si CVE CRITICAL trouvé → envoie immédiatement une alerte Slack
6. Génère un rapport final avec :
   - Score de sécurité global (0-100)
   - CVEs par ordre de criticité avec CVE-ID
   - Misconfigurations K8s
   - Plan de remédiation avec commandes concrètes
7. Envoie le rapport complet sur Slack`,
    tools: [
      { type: "mcp_toolset", mcp_server_name: "kubectl-server" },
      { type: "mcp_toolset", mcp_server_name: "trivy-server" },
      { type: "mcp_toolset", mcp_server_name: "slack-server" },
    ],
    // URLs des MCP servers — à remplacer par les vraies URLs si hébergés
    mcp_servers: [
      { type: "url", name: "kubectl-server", url: process.env.MCP_KUBECTL_URL || "http://localhost:3001" },
      { type: "url", name: "trivy-server",   url: process.env.MCP_TRIVY_URL   || "http://localhost:3002" },
      { type: "url", name: "slack-server",   url: process.env.MCP_SLACK_URL   || "http://localhost:3003" },
    ],
  };

  const res = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  const agent = await res.json() as any;

  if (agent.type === "error") {
    console.error("❌ Erreur API:", agent.error.message);
    process.exit(1);
  }

  console.log("\n✅ Agent créé avec succès !");
  console.log(`   Agent ID : ${agent.id}`);
  console.log(`   Nom      : ${agent.name}`);
  console.log(`   Modèle   : ${agent.model.id}`);
  console.log(`   Créé le  : ${agent.created_at}`);
  console.log("\n👉 Configure le secret GitHub :");
  console.log(`   gh secret set CLAUDE_AGENT_ID --repo ngrassa/managend_agents --body "${agent.id}"`);
}

async function listAgents() {
  const res = await fetch(`${BASE}/agents`, { headers: HEADERS });
  const data = await res.json() as any;
  console.log("\n📋 Agents existants :");
  for (const a of (data.data || [])) {
    console.log(`   ${a.id} | ${a.name} | ${a.model?.id} | créé ${a.created_at}`);
  }
}

const cmd = process.argv[2];
if (cmd === "list") {
  listAgents().catch(console.error);
} else {
  createAgent().catch(console.error);
}

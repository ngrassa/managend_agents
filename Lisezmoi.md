# Lisezmoi — DevSecOps K8s Agent

> Agent autonome de sécurité Kubernetes propulsé par Claude (Anthropic).
> Scanne les clusters EKS, détecte les CVEs, envoie des alertes Telegram.

---

## Récapitulatif final du déploiement

### ✅ Infrastructure AWS (AWS Academy)

| Ressource | Valeur | Statut |
|---|---|---|
| Cluster EKS | `eks-devsecops` | ✅ Running |
| Région | `us-east-1` | ✅ |
| Noeuds | 2 × `t3.medium` (AmazonLinux2023) | ✅ Ready |
| Version K8s | `1.31` | ✅ |
| Clé SSH | `vockey` / `~/.ssh/labsuser.pem` | ✅ |
| Rôle cluster | `LabEksClusterRole` | ✅ |
| Rôle noeuds | `LabEksNodeRole` | ✅ |
| Addons | coredns, kube-proxy, vpc-cni | ✅ Running |

### ✅ Agent Claude (Anthropic Managed Agents beta)

| Paramètre | Valeur |
|---|---|
| Agent ID | `agent_016H69NZqGCQmnggLrbrCJKs` |
| Modèle | `claude-sonnet-4-6` |
| Beta header | `managed-agents-2026-04-01` |
| MCP Server 1 | `kubectl-server` |
| MCP Server 2 | `trivy-server` |
| MCP Server 3 | `telegram-server` |

### ✅ Telegram

| Paramètre | Valeur |
|---|---|
| Bot | `@alert_k8s_grassa_bot` |
| Chat ID | `8484002816` |

### ✅ GitHub Secrets (10/10)

| Secret | Valeur | Statut |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | ✅ Configuré |
| `CLAUDE_AGENT_ID` | `agent_016H69NZqGCQmnggLrbrCJKs` | ✅ Configuré |
| `TELEGRAM_BOT_TOKEN` | `8689238946:AAEx6-...` | ✅ Configuré |
| `TELEGRAM_CHAT_ID` | `8484002816` | ✅ Configuré |
| `EKS_CLUSTER_NAME` | `eks-devsecops` | ✅ Configuré |
| `AWS_ACCESS_KEY_ID` | `ASIA...` | ✅ Configuré |
| `AWS_SECRET_ACCESS_KEY` | `...` | ✅ Configuré |
| `AWS_SESSION_TOKEN` | `IQoJ...` | ✅ Configuré (⚠️ expire toutes les 3-4h) |
| `AWS_REGION` | `us-east-1` | ✅ Configuré |
| `SSH_PRIVATE_KEY` | Contenu de `labsuser.pem` | ✅ Configuré |

### ✅ MCP Servers buildés (0 erreur TypeScript)

| Serveur | Fichier | Outils exposés |
|---|---|---|
| `mcp-kubectl` | `mcp-kubectl/dist/index.js` | `kubectl_get`, `kubectl_describe`, `kubectl_dry_run`, `kubectl_get_images` |
| `mcp-trivy` | `mcp-trivy/dist/index.js` | `trivy_scan_image`, `trivy_scan_manifest`, `trivy_scan_fs` |
| `mcp-telegram` | `mcp-telegram/dist/index.js` | `telegram_alert_critical`, `telegram_send_report` |

### ✅ Pipeline GitHub Actions

- Fichier : `.github/workflows/devsecops-scan.yml`
- Déclencheurs : push sur `k8s/**/*.yaml`, PR vers `master`, cron lundi 6h UTC
- Matrix : namespaces `default`, `production`, `staging`
- Bloque le merge si CVE CRITICAL détecté

---

## Modes de scan disponibles

### Mode local (recommandé pour tester maintenant)

Utilise l'API messages Claude directement avec les outils en sous-processus locaux.

```bash
# Prérequis : crédits Anthropic sur console.anthropic.com/settings/billing
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="8689238946:AAEx6-..."
export TELEGRAM_CHAT_ID="8484002816"

npx ts-node scan-local.ts default
npx ts-node scan-local.ts production
```

### Mode Managed Agents (cloud Anthropic)

Utilise la beta `managed-agents-2026-04-01`. Les MCP servers doivent être exposés via URL publique (ngrok ou hébergement dédié).

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export AGENT_ID="agent_016H69NZqGCQmnggLrbrCJKs"

npx ts-node main.ts default
```

---

## Mettre à jour les credentials AWS Academy

Les tokens AWS Academy **expirent toutes les 3-4 heures**. Quand le pipeline échoue avec `ExpiredTokenException` :

```bash
# 1. AWS Academy → "AWS Details" → copier les nouveaux credentials dans ~/.aws/credentials

# 2. Mettre à jour les 3 secrets GitHub
gh secret set AWS_ACCESS_KEY_ID     --repo ngrassa/managend_agents
gh secret set AWS_SECRET_ACCESS_KEY --repo ngrassa/managend_agents
gh secret set AWS_SESSION_TOKEN     --repo ngrassa/managend_agents
```

---

## Lancer le scan dès les crédits ajoutés

```bash
npx ts-node scan-local.ts default
```

Le scan va :
1. Inventorier pods et deployments du namespace `default`
2. Extraire toutes les images Docker
3. Scanner chaque image avec trivy (CVEs CRITICAL + HIGH)
4. Envoyer une alerte sur `@alert_k8s_grassa_bot` pour chaque CVE critique
5. Générer un rapport scoré /100 avec plan de remédiation
6. Envoyer le rapport complet sur Telegram

---

*Repo : https://github.com/ngrassa/managend_agents*
*Stack : TypeScript · Claude Managed Agents (beta) · MCP · AWS EKS · Trivy · Telegram · GitHub Actions*

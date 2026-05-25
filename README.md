# DevSecOps K8s Agent — Claude/Mistral + MCP + Telegram

Agent autonome de sécurité Kubernetes propulsé par **Mistral AI** (prioritaire) ou **Claude Anthropic**, déployé sur AWS Academy. Il scanne automatiquement les clusters EKS, détecte les vulnérabilités CVE et envoie des alertes sur **Telegram**.

---

## Table des matières

- [Vue d'ensemble](#vue-densemble)
- [Architecture](#architecture)
- [Stack technique](#stack-technique)
- [Structure du projet](#structure-du-projet)
- [MCP Servers](#mcp-servers)
- [Orchestrateur principal](#orchestrateur-principal)
- [Scanner local (recommandé)](#scanner-local-recommandé)
- [Pipeline CI/CD GitHub Actions](#pipeline-cicd-github-actions)
- [Configuration des secrets](#configuration-des-secrets)
- [Démarrage rapide](#démarrage-rapide)
- [Exemple de rapport Telegram](#exemple-de-rapport-telegram)
- [Spécificités AWS Academy](#spécificités-aws-academy)

---

## Vue d'ensemble

Ce projet met en œuvre un **agent IA autonome** capable d'auditer la sécurité d'un cluster Kubernetes sans intervention humaine. À partir d'un simple namespace K8s, l'agent :

1. Inventorie toutes les ressources et images Docker déployées
2. Lance des scans de vulnérabilités CVE sur chaque image avec Trivy
3. Détecte les misconfigurations de sécurité dans les manifests K8s
4. Envoie des **alertes Telegram immédiates** pour chaque CVE CRITICAL
5. Génère un **rapport de sécurité sous forme de tableau** noté sur 100
6. Publie le rapport complet sur Telegram

Le LLM utilisé est **Mistral AI** (`mistral-large-latest`) si `MISTRAL_API_KEY` est défini, sinon **Claude Sonnet 4.6** (Anthropic). Le mode opérationnel principal est `scan-local.ts` (Messages API + outils locaux), qui ne nécessite pas de serveurs MCP exposés publiquement.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   scan-local.ts                         │
│         (Mode opérationnel recommandé)                  │
│                                                         │
│   Priorité LLM : MISTRAL_API_KEY → ANTHROPIC_API_KEY   │
│   - Loop agent avec tool_use (Messages API)             │
│   - Outils exécutés localement (child_process)          │
│   - trivy.log écrit en temps réel                       │
│   - Résultats trivy compactés (évite rate limit)        │
└──────────────┬──────────────────────────────────────────┘
               │ tool_use / tool_result
               ▼
┌──────────────────────────────────────────────────────────┐
│              Outils intégrés (runTool)                   │
├──────────────┬───────────────┬───────────────────────────┤
│  kubectl     │    trivy      │      Telegram             │
│              │               │                           │
│ kubectl_get  │ trivy_scan_   │ telegram_alert_critical   │
│ kubectl_get_ │   image       │ telegram_send_report      │
│   images     │ trivy_scan_   │   (tableau par image)     │
│              │   manifest    │                           │
└──────┬───────┴───────┬───────┴──────────────┬────────────┘
       ▼               ▼                      ▼
┌──────────┐   ┌──────────────┐      ┌──────────────────┐
│  Cluster │   │  Images ECR  │      │  Telegram Bot    │
│  AWS EKS │   │  (AWS ECR)   │      │  @alert_k8s_     │
│          │   │  trivy.log   │      │  grassa_bot      │
└──────────┘   └──────────────┘      └──────────────────┘
```

### Mode cloud (main.ts — expérimental)

`main.ts` utilise l'API **Claude Managed Agents** (beta `managed-agents-2026-04-01`) avec des serveurs MCP (`mcp-kubectl`, `mcp-trivy`, `mcp-telegram`). Ce mode nécessite que les serveurs MCP soient exposés via une URL publique pour être accessibles depuis le cloud Anthropic.

### Flux CI/CD

```
GitHub Actions — devsecops-scan.yml
   │
   ├─ Job 1: trivy-scan (toujours exécuté)
   │     ├─ Installe trivy, configure AWS/kubectl/ECR
   │     ├─ Extrait toutes les images des pods
   │     ├─ Scanne chaque image → trivy.log + trivy-results/*.json
   │     ├─ Scanne les manifests K8s → k8s-manifests/
   │     ├─ Écrit $GITHUB_STEP_SUMMARY (counts CRITICAL/HIGH)
   │     ├─ Upload artifacts: trivy.log + trivy-results/ (30 jours)
   │     └─ Fail pipeline si CVE CRITICAL trouvé
   │
   └─ Job 2: ai-scan (après trivy-scan, même si échec)
         ├─ Télécharge trivy.log depuis job 1
         ├─ npx ts-node scan-local.ts <namespace>
         │     ├─ Mistral/Claude analyse les résultats
         │     ├─ Alertes Telegram par CVE CRITICAL
         │     └─ Rapport Telegram avec tableau par image
         └─ Upload artifact: reports/security-report-*.md
```

---

## Stack technique

| Composant | Technologie | Rôle |
|---|---|---|
| Langage | TypeScript / Node.js 20 | Tout le code |
| LLM principal | Mistral AI `mistral-large-latest` | Raisonnement autonome (priorité) |
| LLM secondaire | Claude Sonnet 4.6 (Anthropic) | Fallback si pas de clé Mistral |
| Protocole outils (cloud) | MCP (Model Context Protocol) v1.29 | Communication agent ↔ outils (mode cloud) |
| Scanner CVE | Trivy v0.70+ (Aqua Security) | Détection de vulnérabilités |
| Infra K8s | AWS EKS (Elastic Kubernetes Service) | Cluster cible |
| Cloud | AWS Academy | Environnement de lab |
| Notifications | Telegram Bot API (`sendMessage`) | Alertes et rapports en temps réel |
| CI/CD | GitHub Actions (2 jobs) | Trivy direct + Agent IA |
| Auth AWS | Credentials temporaires (session token) | Spécificité AWS Academy |

---

## Structure du projet

```
managend_agents/
│
├── README.md                          ← Ce fichier
├── CLAUDE.md                          ← Instructions pour Claude Code
├── Lisezmoi.md                        ← Récapitulatif déploiement complet
├── scan-local.ts                      ← Scanner principal (Messages API + outils locaux)
├── main.ts                            ← Orchestrateur cloud (Managed Agents beta)
├── create-agent.ts                    ← Script création agent via REST
├── tsconfig.json
├── package.json                       ← @anthropic-ai/sdk, @mistralai/mistralai, MCP SDK
│
├── mcp-kubectl/                       ← MCP Server kubectl (mode cloud)
│   ├── index.ts                       ← 4 outils : get, describe, dry_run, get_images
│   └── dist/
│
├── mcp-trivy/                         ← MCP Server trivy (mode cloud)
│   ├── index.ts                       ← 3 outils : scan_image, scan_manifest, scan_fs
│   └── dist/
│
├── mcp-telegram/                      ← MCP Server Telegram (mode cloud)
│   ├── index.ts                       ← 2 outils : alert_critical, send_report
│   └── dist/
│
├── eks-cluster.yaml                   ← Déploiement EKS (LabEksClusterRole)
├── eks-nodegroup.yaml                 ← Node group EKS (LabEksNodeRole)
├── reports/                           ← Rapports générés (ignorés par git)
│   └── security-report-<ns>-<ts>.md
└── .github/
    └── workflows/
        └── devsecops-scan.yml         ← Pipeline CI/CD (2 jobs)
```

---

## MCP Servers

Utilisés en mode cloud (`main.ts`). En mode local (`scan-local.ts`), les outils sont exécutés directement via `child_process` sans serveur MCP intermédiaire.

### mcp-kubectl

**Fichier :** `mcp-kubectl/index.ts`

| Outil | Description | Paramètres |
|---|---|---|
| `kubectl_get` | Liste les ressources K8s | `resource`, `namespace`, `flags` |
| `kubectl_describe` | Détails complets d'une ressource | `resource`, `name`, `namespace` |
| `kubectl_dry_run` | Valide un manifest sans l'appliquer | `manifest_path` |
| `kubectl_get_images` | Liste toutes les images des pods | `namespace` |

### mcp-trivy

**Fichier :** `mcp-trivy/index.ts`

| Outil | Description | Paramètres |
|---|---|---|
| `trivy_scan_image` | Scanne une image Docker pour des CVEs | `image`, `severity` |
| `trivy_scan_manifest` | Scanne les misconfigurations d'un manifest K8s | `path` |
| `trivy_scan_fs` | Scanne un répertoire (dépendances, IaC) | `path`, `scanners` |

Trivy retourne `exit code 1` quand des vulnérabilités sont trouvées — comportement normal, géré via `err.stdout`.

### mcp-telegram

**Fichier :** `mcp-telegram/index.ts` *(remplace mcp-slack)*

| Outil | Description | Paramètres |
|---|---|---|
| `telegram_alert_critical` | Alerte formatée HTML (emoji sévérité, liste CVE, remédiation) | `namespace`, `severity`, `cve_list`, `image`, `remediation` |
| `telegram_send_report` | Rapport complet avec tableau par image | `title`, `score`, `remediation` |

Le token bot (`TELEGRAM_BOT_TOKEN`) et le chat ID (`TELEGRAM_CHAT_ID`) sont injectés via variables d'environnement.

---

## Orchestrateur principal

**Fichier :** `main.ts` — Mode cloud via API Managed Agents (expérimental)

```bash
npx ts-node main.ts production
```

Crée un environnement cloud managé → ouvre une session agent → envoie la tâche → stream les événements SSE. Nécessite que les serveurs MCP soient accessibles via URL publique.

---

## Scanner local (recommandé)

**Fichier :** `scan-local.ts` — Mode opérationnel principal

```bash
# Avec Mistral (prioritaire)
MISTRAL_API_KEY="..." \
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_CHAT_ID="..." \
npx ts-node scan-local.ts kube-system

# Avec Claude Anthropic (fallback)
ANTHROPIC_API_KEY="sk-ant-..." \
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_CHAT_ID="..." \
npx ts-node scan-local.ts kube-system
```

### Points clés

- **Sélection LLM automatique** : si `MISTRAL_API_KEY` est défini, Mistral est utilisé ; sinon Claude.
- **Rate limit Mistral** : retry automatique jusqu'à 5 fois avec 65s d'attente (fenêtre ~1 req/min free tier).
- **trivy.log** : initialisé à chaque scan, enrichi par chaque appel `trivy_scan_image` et `trivy_scan_manifest`, footer ajouté en fin. Consultable localement ou téléchargeable depuis les artifacts GitHub Actions.
- **Compaction JSON trivy** : les résultats bruts (~100 Ko/image) sont résumés en ~2 Ko via `trivySummary()` — évite de saturer le quota tokens/min du LLM.
- **Tableau Telegram** : le rapport final est formaté en tableau ASCII dans un bloc `<pre>` HTML par `buildScanTable()` — construit depuis les données réelles trivy, pas depuis le LLM.
- **Cache trivy** : répertoire par processus `/tmp/trivy-cache-<pid>` pour éviter les conflits de lock en parallèle.

---

## Pipeline CI/CD GitHub Actions

**Fichier :** `.github/workflows/devsecops-scan.yml`

### Déclencheurs

| Déclencheur | Condition |
|---|---|
| `workflow_dispatch` | Manuel depuis GitHub Actions UI (champ `namespace` optionnel) |
| `push` | Modification de fichiers `k8s/**/*.yaml` |
| `pull_request` | Vers les branches `master` ou `production` |
| `schedule` | Chaque lundi à 6h UTC |

### Job 1 — `trivy-scan`

Scan Trivy direct, indépendant du LLM :

1. Installe trivy (script officiel Aqua Security)
2. Configure AWS credentials + kubectl (EKS) + Docker auth ECR
3. Extrait toutes les images via `kubectl get pods --all-namespaces`
4. Scanne chaque image : `--format table` → `trivy.log`, `--format json` → `trivy-results/<image>.json`
5. Dump des manifests K8s → scan misconfigurations
6. Écrit `$GITHUB_STEP_SUMMARY` avec counts CRITICAL/HIGH
7. Upload `trivy.log` + `trivy-results/` comme artifacts (30 jours)
8. **Fail si CVE CRITICAL détecté** → bloque le merge

### Job 2 — `ai-scan` (`needs: trivy-scan`)

Analyse IA + alertes Telegram :

1. Télécharge `trivy.log` depuis job 1
2. Lance `npx ts-node scan-local.ts <namespace>` avec Mistral + Telegram
3. L'agent parcourt kubectl → trivy → alertes Telegram → rapport tableau
4. Upload `reports/security-report-*.md` + `trivy.log` (30 jours)
5. `continue-on-error: true` + `timeout-minutes: 20` — un rate limit LLM ne bloque pas le pipeline

---

## Configuration des secrets

Tous les secrets sont configurés comme **GitHub Actions Secrets** — jamais écrits en clair dans le code.

| Secret | Statut | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Configuré | console.anthropic.com |
| `MISTRAL_API_KEY` | ✅ Configuré | console.mistral.ai |
| `CLAUDE_AGENT_ID` | ✅ Configuré | Après `create-agent.ts` |
| `TELEGRAM_BOT_TOKEN` | ✅ Configuré | @BotFather → @alert_k8s_grassa_bot |
| `TELEGRAM_CHAT_ID` | ✅ Configuré | Chat ID personnel Telegram |
| `AWS_ACCESS_KEY_ID` | ✅ Configuré | AWS Academy → AWS Details |
| `AWS_SECRET_ACCESS_KEY` | ✅ Configuré | AWS Academy → AWS Details |
| `AWS_SESSION_TOKEN` | ✅ Configuré | AWS Academy → AWS Details |
| `AWS_REGION` | ✅ `us-east-1` | AWS Academy |
| `EKS_CLUSTER_NAME` | ✅ `eks-devsecops` | Cluster déployé |
| `SSH_PRIVATE_KEY` | ✅ Configuré | `~/.ssh/labsuser.pem` |

### Mettre à jour les credentials AWS (expirent toutes les 3-4h)

```bash
gh secret set AWS_ACCESS_KEY_ID     --repo ngrassa/managend_agents
gh secret set AWS_SECRET_ACCESS_KEY --repo ngrassa/managend_agents
gh secret set AWS_SESSION_TOKEN     --repo ngrassa/managend_agents
```

### Mettre à jour les secrets Telegram

```bash
gh secret set TELEGRAM_BOT_TOKEN --repo ngrassa/managend_agents
gh secret set TELEGRAM_CHAT_ID   --repo ngrassa/managend_agents
```

---

## Démarrage rapide

### Prérequis

```bash
node --version   # 20+
kubectl get nodes
aws sts get-caller-identity
```

### Installation

```bash
git clone https://github.com/ngrassa/managend_agents.git
cd managend_agents
npm install
```

### Lancer un scan local

```bash
export PATH="$HOME/.local/bin:$PATH"   # si trivy installé localement

MISTRAL_API_KEY="..."           \
TELEGRAM_BOT_TOKEN="..."        \
TELEGRAM_CHAT_ID="..."          \
npx ts-node scan-local.ts kube-system
```

### Déclencher le pipeline CI manuellement

```bash
gh workflow run devsecops-scan.yml \
  --repo ngrassa/managend_agents   \
  --field namespace=kube-system
```

### Build des MCP servers (mode cloud)

```bash
npm run build:all
```

---

## Exemple de rapport Telegram

### Alerte CRITICAL (immédiate)

```
🔴 Alerte DevSecOps — CRITICAL

Namespace : kube-system
Image     : 602401143452.dkr.ecr.us-east-1.amazonaws.com/amazon-k8s-cni:v1.20.5-eksbuild.1

CVEs :
• CVE-2026-33186
• CVE-2025-68121

Remédiation :
kubectl set image daemonset/aws-node aws-node=<latest> -n kube-system

2026-05-25T15:02:42.963Z
```

### Rapport final (avec tableau)

```
🟡 Rapport DevSecOps - Namespace kube-system

Score : 65/100

┌──────────────────────────────┬──────────┬──────┬──────────────────────┐
│ Image                        │ CRITICAL │ HIGH │ CVE CRITICAL (1er)   │
├──────────────────────────────┼──────────┼──────┼──────────────────────┤
│ amazon-k8s-cni:v1.20.5       │        2 │   14 │ CVE-2026-33186       │
│ aws-network-policy-agent:v1. │        2 │   11 │ CVE-2026-33186       │
│ coredns:v1.11.4              │        0 │   19 │ -                    │
│ kube-proxy:v1.31.14          │        0 │   26 │ -                    │
└──────────────────────────────┴──────────┴──────┴──────────────────────┘

📋 Plan :
- Mettre à jour amazon-k8s-cni et aws-network-policy-agent
- Patcher glibc et Go stdlib sur coredns/kube-proxy
- Automatiser les mises à jour via Renovate ou Dependabot
```

---

## Spécificités AWS Academy

### Credentials temporaires

Les credentials AWS Academy **expirent toutes les 3-4 heures**. Quand le pipeline échoue avec `ExpiredTokenException` :

1. Aller dans AWS Academy → "AWS Details" → copier les nouvelles valeurs
2. Mettre à jour `~/.aws/credentials`
3. Mettre à jour les secrets GitHub (voir section Configuration)

### Rôles IAM pré-créés

AWS Academy bloque `iam:CreateRole`. Les rôles utilisés sont ceux déjà créés par le lab :

- `LabEksClusterRole` — rôle IAM du control plane EKS
- `LabEksNodeRole` — rôle IAM des nœuds worker

### Sécurité Git

- Ne jamais committer de credentials AWS dans le repo
- Tous les secrets passent par `${{ secrets.NOM_SECRET }}` dans les workflows
- Révoquer immédiatement tout token GitHub ou clé API exposé accidentellement

---

*Repo : https://github.com/ngrassa/managend_agents*  
*Stack : TypeScript · Mistral AI · Claude Anthropic · MCP · AWS EKS · Trivy · Telegram · GitHub Actions*

# DevSecOps K8s Agent — Claude Managed Agents + MCP + Slack

Agent autonome de sécurité Kubernetes propulsé par Claude (Anthropic), déployé sur AWS Academy via la beta **Managed Agents**. Il scanne automatiquement les clusters EKS, détecte les vulnérabilités CVE et envoie des alertes sur Slack.

---

## Table des matières

- [Vue d'ensemble](#vue-densemble)
- [Architecture](#architecture)
- [Stack technique](#stack-technique)
- [Structure du projet](#structure-du-projet)
- [MCP Servers](#mcp-servers)
  - [mcp-kubectl](#mcp-kubectl)
  - [mcp-trivy](#mcp-trivy)
  - [mcp-slack](#mcp-slack)
- [Orchestrateur principal](#orchestrateur-principal)
- [Pipeline CI/CD GitHub Actions](#pipeline-cicd-github-actions)
- [Configuration des secrets](#configuration-des-secrets)
- [Démarrage rapide](#démarrage-rapide)
- [Exemple de rapport généré](#exemple-de-rapport-généré)
- [Spécificités AWS Academy](#spécificités-aws-academy)

---

## Vue d'ensemble

Ce projet met en œuvre un **agent IA autonome** capable d'auditer la sécurité d'un cluster Kubernetes sans intervention humaine. À partir d'un simple namespace K8s, l'agent :

1. Inventorie toutes les ressources et images Docker déployées
2. Lance des scans de vulnérabilités CVE sur chaque image
3. Détecte les misconfigurations de sécurité dans les manifests K8s
4. Envoie des alertes Slack immédiates pour chaque CVE critique
5. Génère un rapport de sécurité noté sur 100 avec un plan de remédiation
6. Publie le rapport complet sur Slack

Le tout est orchestré via l'API **Claude Managed Agents** (beta) d'Anthropic, qui gère le cycle de vie de l'agent, les sessions, et la communication avec les outils externes via le protocole **MCP** (Model Context Protocol).

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     main.ts                             │
│              (Orchestrateur TypeScript)                 │
│   - Crée un environnement cloud managé                  │
│   - Ouvre une session agent                             │
│   - Envoie la tâche d'audit                             │
│   - Stream les événements en temps réel                 │
│   - Sauvegarde le rapport local                         │
└───────────────────────┬─────────────────────────────────┘
                        │ API Anthropic (beta managed-agents-2026-04-01)
                        ▼
┌─────────────────────────────────────────────────────────┐
│            Claude Managed Agent                         │
│         (claude-sonnet-4-6 — AWS)                       │
│                                                         │
│  Raisonnement autonome :                                │
│  1. Planifie l'audit                                    │
│  2. Sélectionne les outils MCP                          │
│  3. Interprète les résultats                            │
│  4. Prend des décisions (alerter ou non)                │
│  5. Génère le rapport final                             │
└──────┬──────────────────┬──────────────────┬────────────┘
       │ MCP              │ MCP              │ MCP
       ▼                  ▼                  ▼
┌────────────┐   ┌───────────────┐   ┌─────────────┐
│ mcp-kubectl│   │  mcp-trivy    │   │  mcp-slack  │
│            │   │               │   │             │
│ kubectl_get│   │trivy_scan_    │   │slack_alert_ │
│ kubectl_   │   │  image        │   │  critical   │
│  describe  │   │trivy_scan_    │   │slack_send_  │
│ kubectl_   │   │  manifest     │   │  report     │
│  dry_run   │   │trivy_scan_fs  │   │             │
│ kubectl_   │   │               │   │             │
│  get_images│   │               │   │             │
└─────┬──────┘   └──────┬────────┘   └──────┬──────┘
      │                 │                   │
      ▼                 ▼                   ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  Cluster │    │  Images      │    │  Slack       │
│  AWS EKS │    │  Docker Hub  │    │  #alerts     │
│  kubectl │    │  ECR, etc.   │    │  (webhook)   │
└──────────┘    └──────────────┘    └──────────────┘
```

### Flux d'exécution détaillé

```
main.ts
  │
  ├─► environments.create()     → Crée un sandbox cloud isolé
  │
  ├─► sessions.create()         → Démarre une session agent
  │
  ├─► sessions.events.send()    → Envoie la tâche (namespace à auditer)
  │
  └─► sessions.events.stream()  → Stream des événements en temps réel
          │
          ├─ agent.message      → Texte de raisonnement de l'agent
          ├─ agent.tool_use     → Appel d'un outil MCP (kubectl/trivy/slack)
          ├─ session.status_idle → Audit terminé
          └─ session.status_error → Erreur à gérer
```

---

## Stack technique

| Composant | Technologie | Rôle |
|---|---|---|
| Langage | TypeScript / Node.js 20 | Tout le code |
| IA | Claude Sonnet 4.6 (Managed Agents beta) | Raisonnement autonome |
| Protocole outils | MCP (Model Context Protocol) v1.29 | Communication agent ↔ outils |
| Scanner CVE | Trivy (Aqua Security) | Détection de vulnérabilités |
| Infra K8s | AWS EKS (Elastic Kubernetes Service) | Cluster cible |
| Cloud | AWS Academy | Environnement de lab |
| Notifications | Slack API (chat.postMessage) | Alertes et rapports |
| CI/CD | GitHub Actions | Automatisation des scans |
| Auth AWS | Credentials temporaires (session token) | Spécificité AWS Academy |

---

## Structure du projet

```
managend_agents/
│
├── README.md                          ← Ce fichier
├── CLAUDE.md                          ← Instructions pour Claude Code
├── main.ts                            ← Orchestrateur principal
├── tsconfig.json                      ← Config TypeScript (CommonJS)
├── package.json                       ← Dépendances root (@anthropic-ai/sdk)
│
├── mcp-kubectl/                       ← MCP Server kubectl
│   ├── index.ts                       ← 4 outils : get, describe, dry_run, get_images
│   ├── tsconfig.json                  ← Config TypeScript (ESM / NodeNext)
│   ├── package.json
│   └── dist/                          ← Build compilé (généré par tsc)
│
├── mcp-trivy/                         ← MCP Server trivy
│   ├── index.ts                       ← 3 outils : scan_image, scan_manifest, scan_fs
│   ├── tsconfig.json
│   ├── package.json
│   └── dist/
│
├── mcp-slack/                         ← MCP Server Slack
│   ├── index.ts                       ← 2 outils : alert_critical, send_report
│   ├── tsconfig.json
│   ├── package.json
│   └── dist/
│
├── reports/                           ← Rapports générés (ignorés par git)
│   └── security-report-<ns>-<ts>.md
│
└── .github/
    └── workflows/
        └── devsecops-scan.yml         ← Pipeline CI/CD GitHub Actions
```

---

## MCP Servers

Les MCP Servers sont des processus Node.js indépendants qui exposent des outils à l'agent Claude via le protocole stdio MCP. Chaque serveur est déclaré à la création de l'agent et ne peut pas être ajouté dynamiquement.

### mcp-kubectl

**Fichier :** `mcp-kubectl/index.ts`

Expose 4 outils pour inspecter un cluster Kubernetes via `kubectl` :

| Outil | Description | Paramètres |
|---|---|---|
| `kubectl_get` | Liste les ressources K8s (pods, deployments, services…) | `resource`, `namespace`, `flags` |
| `kubectl_describe` | Détails complets d'une ressource | `resource`, `name`, `namespace` |
| `kubectl_dry_run` | Valide un manifest sans l'appliquer | `manifest_path` |
| `kubectl_get_images` | Liste toutes les images des pods | `namespace` |

Chaque commande a un timeout de 30 secondes. Les erreurs kubectl sont remontées comme texte (pas d'exception levée) pour que l'agent puisse interpréter le message d'erreur.

---

### mcp-trivy

**Fichier :** `mcp-trivy/index.ts`

Expose 3 outils de scan de sécurité via `trivy` (Aqua Security) :

| Outil | Description | Paramètres |
|---|---|---|
| `trivy_scan_image` | Scanne une image Docker pour des CVEs | `image`, `severity` (défaut: CRITICAL,HIGH) |
| `trivy_scan_manifest` | Scanne les misconfigurations d'un manifest K8s | `path` |
| `trivy_scan_fs` | Scanne un répertoire (dépendances, secrets, IaC) | `path`, `scanners` |

**Note importante :** Trivy retourne `exit code 1` quand des vulnérabilités sont trouvées — ce comportement est normal et géré explicitement (on lit `err.stdout` pour récupérer le JSON des résultats). Timeout de 120 secondes, buffer de 10 MB pour les gros scans.

---

### mcp-slack

**Fichier :** `mcp-slack/index.ts`

Expose 2 outils pour envoyer des messages sur Slack via l'API `chat.postMessage` :

| Outil | Description | Paramètres |
|---|---|---|
| `slack_alert_critical` | Alerte formatée avec blocs Slack (emoji sévérité, CVE list, remédiation) | `namespace`, `severity`, `cve_list`, `image`, `remediation` |
| `slack_send_report` | Envoie le rapport complet (score + contenu Markdown tronqué à 2000 chars) | `report_content`, `title`, `score` |

Le token Slack (`SLACK_BOT_TOKEN`) et le canal par défaut (`SLACK_CHANNEL_ID`) sont injectés via variables d'environnement — jamais écrits en dur.

---

## Orchestrateur principal

**Fichier :** `main.ts`

Point d'entrée du programme. Prend un namespace K8s en argument (défaut : `default`).

```bash
npx ts-node main.ts production
npx ts-node main.ts staging
```

### Ce qu'il fait

1. **Crée un environnement cloud managé** avec networking unrestricted (nécessaire pour que trivy puisse télécharger les bases de données CVE et que Slack soit joignable)
2. **Ouvre une session agent** liée à cet environnement
3. **Envoie la tâche** : instructions précises en 7 étapes pour l'audit complet
4. **Stream les événements** : affiche le raisonnement de l'agent en temps réel, log chaque appel d'outil, compte les alertes critiques
5. **Sauvegarde le rapport** localement dans `reports/security-report-<namespace>-<timestamp>.md`
6. **Affiche un résumé** : chemin du rapport, outils utilisés, nombre d'alertes critiques

### Variables d'environnement requises

```bash
ANTHROPIC_API_KEY=sk-ant-...      # Clé API Anthropic
AGENT_ID=agent_...                 # ID de l'agent créé avec `ant beta:agents create`
SLACK_BOT_TOKEN=xoxb-...          # Token bot Slack
SLACK_CHANNEL_ID=C0XXXXXXX        # ID du canal Slack
```

---

## Pipeline CI/CD GitHub Actions

**Fichier :** `.github/workflows/devsecops-scan.yml`

### Déclencheurs

| Déclencheur | Condition |
|---|---|
| `push` | Modification de fichiers `k8s/**/*.yaml` ou `k8s/**/*.yml` |
| `pull_request` | Vers les branches `master` ou `production` |
| `schedule` | Chaque lundi à 6h UTC (`cron: "0 6 * * 1"`) |

### Stratégie matrix

Le pipeline lance **3 jobs en parallèle**, un par namespace :
- `default`
- `production`
- `staging`

### Étapes du pipeline

```
1. Checkout du code
2. Setup Node.js 20 avec cache npm
3. npm ci (dépendances root)
4. Build des 3 MCP servers (npm ci + tsc dans chaque sous-dossier)
5. Installation de trivy (script officiel Aqua Security)
6. Configuration des credentials AWS Academy (avec session token)
7. Configuration de la clé SSH labsuser.pem
8. Configuration de kubectl (aws eks update-kubeconfig)
9. Lancement du scan : npx ts-node main.ts <namespace>
10. Upload du rapport en artifact GitHub (rétention 30 jours)
11. Fail si CVE CRITICAL détecté → bloque le merge
```

### Comportement sur CVE critique

Si le rapport contient le mot `CRITICAL`, le pipeline **échoue avec exit code 1**, bloquant tout merge vers `master` ou `production`. Cela garantit qu'aucun déploiement ne passe avec une vulnérabilité critique non traitée.

---

## Configuration des secrets

Tous les secrets sont configurés comme **GitHub Actions Secrets** via `gh` CLI — jamais écrits en clair dans le code.

| Secret | Statut | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | ⏳ À configurer | console.anthropic.com |
| `CLAUDE_AGENT_ID` | ⏳ À configurer | Après `ant beta:agents create` |
| `SLACK_BOT_TOKEN` | ⏳ À configurer | api.slack.com/apps |
| `SLACK_CHANNEL_ID` | ⏳ À configurer | Slack → canal → détails |
| `AWS_ACCESS_KEY_ID` | ✅ Configuré | `~/.aws/credentials` (AWS Academy) |
| `AWS_SECRET_ACCESS_KEY` | ✅ Configuré | `~/.aws/credentials` (AWS Academy) |
| `AWS_SESSION_TOKEN` | ✅ Configuré | `~/.aws/credentials` (AWS Academy) |
| `AWS_REGION` | ✅ `us-east-1` | `~/.aws/config` |
| `SSH_PRIVATE_KEY` | ✅ Configuré | `~/.ssh/labsuser.pem` (clé `vockey`) |
| `EKS_CLUSTER_NAME` | ⏳ À configurer | Après déploiement EKS |

### Mettre à jour un secret

```bash
gh secret set ANTHROPIC_API_KEY --repo ngrassa/managend_agents
gh secret set SLACK_BOT_TOKEN --repo ngrassa/managend_agents
gh secret set EKS_CLUSTER_NAME --repo ngrassa/managend_agents
```

---

## Démarrage rapide

### Prérequis

```bash
# Node.js 20+
node --version

# kubectl configuré
kubectl get nodes

# trivy installé
trivy --version

# AWS CLI configuré (AWS Academy)
aws sts get-caller-identity
```

### Installation

```bash
git clone https://github.com/ngrassa/managend_agents.git
cd managend_agents

# Dépendances root
npm install

# Dépendances et build des MCP servers
for dir in mcp-kubectl mcp-trivy mcp-slack; do
  cd $dir && npm install && npm run build && cd ..
done
```

### Créer l'agent (une seule fois)

```bash
ant beta:agents create \
  --name "k8s-devsecops-agent" \
  --model '{"id": "claude-sonnet-4-6"}' \
  --system "Tu es un expert DevSecOps spécialisé AWS EKS..." \
  --tool '{"type": "agent_toolset_20260401"}' \
  --mcp-server '{"name": "kubectl-server", "command": "node", "args": ["./mcp-kubectl/dist/index.js"]}' \
  --mcp-server '{"name": "trivy-server", "command": "node", "args": ["./mcp-trivy/dist/index.js"]}' \
  --mcp-server '{"name": "slack-server", "command": "node", "args": ["./mcp-slack/dist/index.js"]}'

# Récupérer l'agent.id et le configurer
gh secret set CLAUDE_AGENT_ID --repo ngrassa/managend_agents
```

### Lancer un audit

```bash
# Audit du namespace default
npx ts-node main.ts default

# Audit du namespace production
npx ts-node main.ts production

# Auditer plusieurs namespaces en parallèle
for ns in default production staging; do
  npx ts-node main.ts $ns &
done
wait
```

### Configurer kubectl pour EKS

```bash
aws eks update-kubeconfig \
  --region us-east-1 \
  --name <EKS_CLUSTER_NAME>

kubectl get nodes
```

---

## Exemple de rapport généré

```markdown
## Rapport DevSecOps — Namespace: production
## Score de sécurité : 42/100 🟠

### 🔴 CVEs Critiques (action immédiate requise)
| CVE           | Image        | Package  | Fix disponible      |
|---------------|--------------|----------|---------------------|
| CVE-2024-1234 | node:latest  | openssl  | node:20.11-alpine   |
| CVE-2024-5678 | nginx:1.21   | zlib     | nginx:1.25-alpine   |

### 🟠 Misconfigurations K8s détectées
1. `privileged: true` sur deployment api-backend → supprimer
2. `runAsUser: 0` (root) sur 3 pods → changer pour UID 1000
3. Secrets en clair dans les env vars → migrer vers K8s Secrets

### ✅ Plan de remédiation
# Mettre à jour les images vulnérables
kubectl set image deployment/api-backend api=node:20.11-alpine -n production

# Patcher le contexte de sécurité (supprimer root)
kubectl patch deployment api-backend -n production -p \
  '{"spec":{"template":{"spec":{"securityContext":{"runAsUser":1000}}}}}'

# Créer un Secret K8s pour les credentials DB
kubectl create secret generic db-creds \
  --from-literal=password='...' -n production
```

---

## Spécificités AWS Academy

### Credentials temporaires

Les credentials AWS Academy **expirent toutes les 3-4 heures**. Quand le pipeline échoue avec `ExpiredTokenException` :

1. Aller dans AWS Academy → "AWS Details" → copier les nouveaux credentials
2. Mettre à jour `~/.aws/credentials`
3. Mettre à jour les secrets GitHub :

```bash
# Lire les nouvelles valeurs
cat ~/.aws/credentials

# Mettre à jour les secrets
gh secret set AWS_ACCESS_KEY_ID --repo ngrassa/managend_agents
gh secret set AWS_SECRET_ACCESS_KEY --repo ngrassa/managend_agents
gh secret set AWS_SESSION_TOKEN --repo ngrassa/managend_agents
```

### Clé SSH

La clé privée `~/.ssh/labsuser.pem` (paire de clés `vockey`) est utilisée pour SSH vers les nœuds EKS si nécessaire.

```bash
# Permissions obligatoires
chmod 400 ~/.ssh/labsuser.pem

# Connexion à un nœud EKS
ssh -i ~/.ssh/labsuser.pem ec2-user@<NODE_PUBLIC_IP>
```

### Sécurité Git

- Ne jamais committer de credentials AWS dans le repo
- Tous les secrets passent par `${{ secrets.NOM_SECRET }}` dans les workflows
- Révoquer immédiatement tout token GitHub exposé accidentellement

---

*Repo : https://github.com/ngrassa/managend_agents*
*Stack : TypeScript · Claude Managed Agents (beta) · MCP · AWS EKS · Trivy · Slack · GitHub Actions*

# Meeting-Room-Portal

Meeting Room Portal for Volkswind : portail de réservation des salles de réunion d'un tenant Microsoft 365 pour les utilisateurs d'un tenant partenaire.

La solution est **redéployable sur n'importe quel tenant Microsoft 365** (cloud public). Une installation correspond à un fichier `deployments/<nom>.json` ; un script unique la crée ou la met en conformité.

Architecture et choix de sécurité : [docs/architecture.md](docs/architecture.md).

## Structure

| Dossier | Contenu |
|---|---|
| `server/` | API + BFF Node.js/TypeScript (Express, MSAL, Graph, Table Storage) |
| `web/` | Front React (Vite), servi par le serveur en production |
| `infra/` | Bicep : App Service, VNet, Storage, Key Vault, Log Analytics, Managed Identity |
| `scripts/` | `deploy.ps1` (orchestrateur), `build-package.ps1`, configuration Entra ID / Exchange / Teams |
| `deployments/` | Une configuration par installation (`<nom>.json`) + l'état généré (`<nom>.state.json`) |
| `.github/workflows/` | Build et tests à chaque push ; mise à jour d'une installation à la demande |

## Ce qu'il faut dans le tenant cible

| Élément | Remarque |
|---|---|
| Abonnement Azure **rattaché à ce tenant** | L'identité managée doit vivre dans le tenant des boîtes Exchange : le script le vérifie |
| Exchange Online avec des boîtes de salle | Toutes les boîtes de type `RoomMailbox` deviennent réservables |
| Boîte organisatrice | Boîte **utilisateur** licenciée Exchange + Teams (ex. `resa-externe@…`). Bloquer ses connexions interactives par accès conditionnel |
| Entra ID P1 | Attribution d'un groupe à un rôle d'app, accès conditionnel |
| Invités B2B du partenaire | Comptes invités existants, retrouvés par leur domaine e-mail |
| Administrateur | Owner (ou Contributor + User Access Administrator) sur l'abonnement, Application Administrator + Conditional Access Administrator, Exchange Administrator, Teams Administrator |

Poste d'administration : PowerShell 7, Azure CLI, Node.js 22, modules `Microsoft.Graph`, `ExchangeOnlineManagement`, `MicrosoftTeams`. L'étape `Prerequisites` du script indique ce qui manque.

## Installer sur un tenant

1. Copier `deployments/example.json` vers `deployments/<nom>.json` (ex. `test`, `prod`) et le renseigner. Le schéma `deployment.schema.json` apporte l'autocomplétion dans VS Code.
2. Se connecter au tenant cible :
   ```powershell
   az login --tenant <tenantId>
   ```
3. Lancer :
   ```powershell
   ./scripts/deploy.ps1 -Config deployments/<nom>.json
   ```
   Le script affiche la cible, puis demande de retaper le nom de l'installation pour confirmer. Il enchaîne ensuite :
   - prérequis ;
   - infrastructure ;
   - Entra ID (avec un second passage sur l'infrastructure pour transmettre le Client ID) ;
   - Exchange ;
   - Teams ;
   - application.

   Les sessions Graph, Exchange et Teams s'ouvrent dans le navigateur. Chaque script refuse de continuer si la session ouverte n'est pas celle du tenant attendu.
4. Committer `deployments/<nom>.json` et `deployments/<nom>.state.json`. Ils ne contiennent aucun secret.
5. Recette, puis activation de la stratégie d'accès conditionnel `CA-MeetingRoomPortal-<nom>-Partner-MFA`, créée en mode « rapport seulement ».

Relancer le script est sans risque : tout est idempotent. Les options utiles :
- `-Steps Infra,App` : ne rejouer qu'une partie des étapes ;
- `-RotateSessionSecret` : changer la clé de session ;
- `-PackagePath app.zip` : déployer un paquet déjà construit.

> Exchange RBAC for Applications peut mettre jusqu'à 2 h à se propager. D'ici là, l'application renvoie « service de calendrier indisponible ».

### Domaine personnalisé

Ajouter `"customDomain": "reservation.contoso.com"` (sous-domaine, pas de domaine racine) dans `deployments/<nom>.json`, puis :

1. Lancer `./scripts/deploy.ps1 -Config deployments/<nom>.json -Steps Infra`. Si le DNS n'est pas prêt, le script affiche les deux enregistrements à créer et laisse l'application sur l'URL `azurewebsites.net` :
   - `CNAME reservation.contoso.com → app-…azurewebsites.net`
   - `TXT asuid.reservation.contoso.com = <identifiant de vérification>`
2. Une fois le DNS propagé, relancer `-Steps Infra,Entra,App`. Le script vérifie le DNS, lie le domaine, fait émettre le certificat managé gratuit (renouvelé automatiquement) et active le TLS SNI. L'URL publique de l'application devient le domaine personnalisé.
3. L'app registration reçoit les deux redirections (`https://<domaine>/auth/callback` et l'URL `azurewebsites.net`), ce qui permet de revenir en arrière.

Si le domaine passe par Cloudflare, désactiver le proxy le temps de l'émission du certificat.

### HTTPS

Le HTTPS est imposé à trois niveaux : `httpsOnly` sur l'App Service (redirection HTTP → HTTPS, TLS 1.2 minimum, FTP désactivé), redirection 308 côté application en production, et en-tête HSTS d'un an.

### Plusieurs installations

Chaque installation a ses propres ressources Azure et ses propres objets Microsoft 365. Ceux-ci sont tous suffixés par le nom de l'installation : app registration, groupe, accès conditionnel, périmètre Exchange, stratégie Teams. On peut donc :
- passer d'un tenant de test à un tenant de production en déployant `test.json`, puis `prod.json` avec le **même paquet** ;
- faire cohabiter `test` et `prod` dans un même tenant.

Rien n'est déplacé d'un tenant à l'autre : les réservations restent propres à chaque installation.

## Mises à jour via GitHub Actions

Chaque push sur `main` lance les tests et produit le paquet `app.zip`. Pour mettre à jour une installation existante (infrastructure et application) :

1. Créer un environnement GitHub portant le nom de l'installation, avec les variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` et `AZURE_SUBSCRIPTION_ID`. Ces variables désignent une app registration de déploiement **du tenant cible**, dotée d'un credential fédéré `repo:<org>/<repo>:environment:<nom>` et des droits Owner sur le groupe de ressources. Ajouter des réviseurs obligatoires pour la production.
2. Lancer *Run workflow* en indiquant le nom de l'installation.

La première installation se fait toujours avec `deploy.ps1` depuis un poste administrateur, car les étapes Entra, Exchange et Teams exigent des rôles d'administration Microsoft 365.

## Développement local

```bash
cp server/env.template server/.env   # renseigner les valeurs (app registration de DEV)
cd server && npm install && npm run dev
cd web && npm install && npm run dev  # http://localhost:5173
npm test                              # dans server/ : tests des règles et de l'autorisation
```

Le stockage local utilise [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite). Avec `allowInternalUsers: true`, l'app registration accepte aussi la redirection `http://localhost:5173`.

## Exploitation

- **Nouvelles salles** : rien à faire. Le runbook `Sync-RoomDirectory` (Azure Automation) les transmet au portail en 15 minutes au plus. En cas de doute, ouvrez le compte Automation `aa-…`, puis *Tâches* : chaque exécution affiche le nombre de salles transmises, ajoutées et retirées.
- **Nouveaux invités du partenaire** : relancer `deploy.ps1 -Steps Entra`, ou les ajouter au groupe `SG-MeetingRoomPortal-<nom>-PartnerGuests`. Une revue d'accès trimestrielle sur ce groupe est recommandée.
- **Audit** : table `audit` du compte de stockage, et `AppServiceConsoleLogs` dans Log Analytics (lignes `"type":"audit"`).
- **Règles de réservation** : bloc `booking` de la configuration, puis `deploy.ps1 -Steps Infra`.

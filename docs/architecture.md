# Architecture — Meeting Room Portal

Portail web permettant aux utilisateurs d'**un tenant Microsoft 365 partenaire** de réserver **toutes nos salles de réunion**, avec réunion Teams associée.

## Décisions

| Sujet | Décision | Raison |
|---|---|---|
| Identité des externes | Invités Entra B2B **déjà existants** dans notre tenant, regroupés dans `SG-MeetingRoomPortal-PartnerGuests` | Nos stratégies d'accès conditionnel s'appliquent ; révocation centralisée |
| Autorisation | Rôle d'app `Room.Booker` + « assignment required » + contrôle serveur du tenant d'origine (claim `idp`) | Trois verrous indépendants |
| Accès aux calendriers | Graph **app-only**, borné par **Exchange RBAC for Applications** aux salles + boîte organisatrice | Une compromission de l'app ne donne accès à aucune autre boîte |
| Réservation | Événement créé dans la boîte organisatrice `resa-externe@…`, salle en ressource | Les règles de chaque salle (auto-accept, conflits, durée) restent appliquées par Exchange |
| Teams | `isOnlineMeeting` sur l'événement ; stratégie Teams dédiée sur l'organisateur | L'organisateur ne rejoint jamais : les invités doivent entrer sans salle d'attente |
| Hébergement | App Service Linux **B1** (version économique), pas de Front Door/WAF | Coût ; compensé par rate limiting applicatif, CSP stricte et surface minimale |
| Réseau | Intégration VNet + **service endpoints** ; Storage et Key Vault fermés à Internet | Isolement des données sans le coût des private endpoints |
| Données | Azure **Table Storage** (réservations, audit), auth Entra uniquement (clé partagée désactivée) | Volume faible, coût quasi nul |
| Secrets | **Aucun secret client** : la Managed Identity est credential fédéré de l'app registration ; seule la clé de cookie de session est dans Key Vault | Rien à faire tourner, rien à fuiter |
| Déploiement | Bicep + GitHub Actions avec fédération OIDC | Aucun secret de déploiement ; FTP/SCM basic auth désactivés |

## Schéma

```
 Tenant partenaire                         Notre tenant
 ┌──────────────┐  SSO compte d'origine    ┌───────────────────────────────────────────┐
 │ Utilisateur  │──(MFA partenaire reconnue)▶ Entra ID                                  │
 │ externe      │                         │  • Invité B2B ∈ SG-…-PartnerGuests         │
 └──────┬───────┘                         │  • App « Meeting Room Portal »             │
        │ HTTPS                           │    assignment required, rôle Room.Booker   │
        ▼                                 │  • CA : MFA + sign-in frequency 12 h       │
 ┌───────────────────────────────┐        └───────────────────────────────────────────┘
 │ App Service Linux B1 (Node 22) │
 │  Express (BFF) + React         │  Graph app-only   ┌──────────────────────────────┐
 │  • OIDC code + PKCE (MSAL)     │──────────────────▶│ Exchange Online              │
 │  • cookie chiffré HttpOnly     │  (Managed Id.)    │ • resa-externe@ (organisat.) │
 │  • règles métier serveur       │                   │ • toutes les RoomMailbox     │
 │  • CSP, HSTS, rate limiting    │                   │ RBAC for Apps : périmètre    │
 └───────┬───────────────┬────────┘                   │ limité à ces boîtes          │
         │ VNet + service endpoints                    └──────────────────────────────┘
         ▼               ▼
  ┌─────────────┐  ┌──────────────┐     App Insights / Log Analytics (logs App Service,
  │ Table       │  │ Key Vault    │     audit Storage et Key Vault, journal d'audit applicatif)
  │ Storage     │  │ session-key  │
  └─────────────┘  └──────────────┘
```

## Parcours de réservation

1. L'utilisateur se connecte : `/auth/login` (code + PKCE, `state`, `nonce`) → Entra ID → redirection vers le tenant partenaire → retour `/auth/callback`.
2. Le serveur valide `tid` = notre tenant, rôle `Room.Booker`, `idp` = tenant partenaire, puis ouvre une session (cookie chiffré, 8 h). **Aucun jeton n'est conservé.**
3. Planning : `getSchedule` sur toutes les salles. Seules les plages occupées sont renvoyées, **jamais l'objet des réunions internes**.
4. Réservation : contrôles serveur (créneau, horizon, durée, week-end, quota, domaines des participants, objet sans lien/HTML), vérification de disponibilité, puis création de l'événement Teams dans la boîte organisatrice.
5. La salle accepte ou refuse automatiquement ; le statut est relu dans « Mes réservations ».
6. Annulation : uniquement sur ses propres réservations (recherche dans la partition `oid` de l'utilisateur).

## Mesures de sécurité applicatives

- **CSRF** : cookie `SameSite=Lax`, en-tête `X-Requested-With` obligatoire et contrôle de l'`Origin` sur toute écriture.
- **XSS** : React (échappement), CSP `default-src 'self'` sans `unsafe-inline`, `frame-ancestors 'none'`.
- **Abus** : 120 requêtes/min par IP, 20 réservations/h par utilisateur, 10 réservations à venir max.
- **Relais de spam** : participants additionnels limités à `ALLOWED_ATTENDEE_DOMAINS`.
- **Phishing interne** : objet nettoyé (pas de lien, de balise ni de caractère invisible), préfixé `[Externe – Partenaire]`.
- **Traçabilité** : connexions (réussies/refusées), créations, annulations → table `audit` + Log Analytics.

## Portabilité entre tenants

Aucune valeur propre à un tenant n'est écrite dans le code, le Bicep ou les scripts. Une installation est entièrement décrite par `deployments/<nom>.json` :

| Contenu | Origine |
|---|---|
| Tenant cible, abonnement, région, partenaire, organisateur, règles | Saisis dans `deployments/<nom>.json` |
| Client ID, identité managée, URL | Générés et enregistrés dans `deployments/<nom>.state.json` |
| Clé de session | Générée à la création, stockée uniquement dans Key Vault ; conservée lors des redéploiements |

Garde-fous :
- **Tenant vérifié** : chaque étape contrôle qu'elle agit bien sur le tenant attendu (Azure CLI, Graph, Exchange, Teams), et que l'abonnement appartient au même tenant que les boîtes Exchange.
- **Pas de collision** : tous les objets sont nommés d'après l'installation (`MeetingRoomPortal-<nom>`), ce qui permet plusieurs installations par tenant.
- **Pas d'écrasement** : l'attribut Exchange qui marque la boîte organisatrice est configurable, et le script refuse d'écraser une valeur existante.
- **Changement de tenant = redéploiement** : changer l'annuaire d'un abonnement casserait l'identité managée, les attributions de rôles et Key Vault, et ne déplacerait aucun objet Entra ou Exchange.

Limite : cloud public uniquement (`login.microsoftonline.com`, `graph.microsoft.com`). GCC High et 21Vianet demanderaient de rendre ces points de terminaison configurables.

## Limites connues (version économique)

- Pas de WAF : passer à Front Door Premium + Private Link si l'exposition ou la menace augmente (≈ +300 €/mois).
- Révocation : un invité retiré du groupe garde sa session jusqu'à 8 h.
- Une seule instance B1 : pas de slot de déploiement ni de haute disponibilité (passer en P0v3 si besoin).

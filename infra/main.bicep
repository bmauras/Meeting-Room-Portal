metadata description = 'Meeting Room Portal — version économique : App Service Linux + intégration VNet + service endpoints, Table Storage, Key Vault, aucun secret applicatif hors cookie de session.'

targetScope = 'resourceGroup'

@description('Préfixe des noms de ressources (minuscules et chiffres uniquement).')
@maxLength(10)
param namePrefix string = 'roomportal'

@description('Nom court de l\'installation (minuscules et chiffres), par exemple test ou prod.')
@minLength(1)
@maxLength(8)
param environmentName string = 'prod'

param location string = resourceGroup().location

@description('Tenant ID du tenant partenaire dont les invités peuvent réserver.')
param partnerTenantId string

@description('Nom du partenaire, affiché dans le portail et en préfixe des réunions.')
param partnerDisplayName string

@description('Client ID de l\'app registration de connexion (sortie de scripts/01-entra.ps1). Vide au premier déploiement.')
param entraClientId string = ''

@description('UPN de la boîte utilisateur organisatrice des réservations (licence Exchange + Teams).')
param organizerUpn string

@description('Domaines autorisés pour les participants additionnels, séparés par des virgules.')
param allowedAttendeeDomains string

@description('Nom d\'hôte personnalisé (ex. reservation.contoso.com). Vide = https://<app>.azurewebsites.net')
param customDomain string = ''

@description('Lier le domaine personnalisé et émettre le certificat managé. À activer une fois le CNAME et le TXT asuid créés dans le DNS.')
param bindCustomDomain bool = false

@description('Clé de chiffrement des cookies de session (32 caractères minimum). Vide = conserver la clé déjà stockée dans Key Vault.')
@secure()
param sessionSecret string = ''

@description('Autorise les comptes membres du tenant ayant le rôle Room.Booker (recette uniquement).')
param allowInternalUsers bool = false

@description('Règles de réservation appliquées par le serveur.')
param bookingRules object = {
  dayStart: '08:00'
  dayEnd: '19:00'
  slotMinutes: 15
  maxDurationMinutes: 240
  horizonDays: 30
  maxActivePerUser: 10
  allowWeekends: false
}

@description('Annuaire des salles relevé dans Exchange (JSON [{email, name, capacity}]) : complète l\'API Places, lente à synchroniser les nouvelles salles.')
param roomDirectory string = '[]'

@description('Domaine initial du tenant (*.onmicrosoft.com) : connexion Exchange du runbook de synchronisation des salles. Vide au premier déploiement.')
param tenantInitialDomain string = ''

@description('Version du module ExchangeOnlineManagement importé dans Azure Automation.')
param exchangeModuleVersion string = '3.6.0'

@description('Région du compte Azure Automation (quota par région : peut différer du reste de l\'installation).')
param automationLocation string = location

@allowed(['B1', 'B2', 'P0v3', 'P1v3'])
param appServiceSkuName string = 'B1'

param vnetAddressPrefix string = '10.60.0.0/24'
param appSubnetPrefix string = '10.60.0.0/26'

@description('Fuseau horaire des salles (IANA).')
param timeZone string = 'Europe/Paris'

param tags object = {
  application: 'meeting-room-portal'
  environment: environmentName
}

var suffix = take(uniqueString(resourceGroup().id), 6)
var baseName = '${namePrefix}-${environmentName}-${suffix}'
var appName = 'app-${baseName}'
var storageName = take(toLower('st${namePrefix}${environmentName}${suffix}'), 24)
var keyVaultName = take('kv-${namePrefix}-${suffix}', 24)
var defaultBaseUrl = 'https://${appName}.azurewebsites.net'
var useCustomDomain = !empty(customDomain) && bindCustomDomain
var publicBaseUrl = useCustomDomain ? 'https://${customDomain}' : defaultBaseUrl

var roles = {
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
}

// ---------------------------------------------------------------- Supervision

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${baseName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${baseName}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ---------------------------------------------------------------- Identité

// User-assigned : ses identifiants existent avant l'App Service et sont stables, ce qui permet
// de configurer Entra ID (credential fédéré) et Exchange (RBAC for Applications) à l'avance.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${baseName}'
  location: location
  tags: tags
}

// ---------------------------------------------------------------- Réseau

// Intégration VNet sortante + service endpoints : Storage et Key Vault ne sont joignables que
// depuis le sous-réseau de l'application, sans le coût de private endpoints.
var vnetName = 'vnet-${baseName}'
var appSubnetName = 'snet-app'
// Identifiant calculé (et non lu sur la ressource) : la validation préalable du stockage et de
// Key Vault exige une valeur connue avant le déploiement, sinon tout redéploiement est rejeté.
var appSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, appSubnetName)

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: appSubnetName
        properties: {
          addressPrefix: appSubnetPrefix
          delegations: [
            {
              name: 'webapp'
              properties: { serviceName: 'Microsoft.Web/serverFarms' }
            }
          ]
          serviceEndpoints: [
            { service: 'Microsoft.Storage' }
            { service: 'Microsoft.KeyVault' }
          ]
        }
      }
    ]
  }
}

// ---------------------------------------------------------------- Données

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [
        { id: appSubnetId, action: 'Allow' }
      ]
    }
  }
  dependsOn: [vnet]
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource bookingsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'bookings'
}

resource directoryTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'directory'
}

resource auditTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'audit'
}

resource storageTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, roles.storageTableDataContributor)
  scope: storage
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageTableDataContributor)
  }
}

// ---------------------------------------------------------------- Secrets

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [
        { id: appSubnetId, ignoreMissingVnetServiceEndpoint: false }
      ]
    }
  }
  dependsOn: [vnet]
}

// Écrit uniquement quand une valeur est fournie : un redéploiement sans secret conserve les sessions en cours.
resource sessionSecretKv 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(sessionSecret)) {
  parent: keyVault
  name: 'session-secret'
  properties: {
    value: sessionSecret
  }
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, roles.keyVaultSecretsUser)
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
  }
}

// ---------------------------------------------------------------- Application

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${baseName}'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: appServiceSkuName }
  properties: {
    reserved: true
  }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    virtualNetworkSubnetId: appSubnetId
    vnetRouteAllEnabled: true
    keyVaultReferenceIdentity: identity.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node dist/index.js'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/healthz'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
        { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
        { name: 'TENANT_ID', value: tenant().tenantId }
        { name: 'PARTNER_TENANT_ID', value: partnerTenantId }
        { name: 'PARTNER_DISPLAY_NAME', value: partnerDisplayName }
        { name: 'ALLOW_INTERNAL_USERS', value: allowInternalUsers ? 'true' : 'false' }
        { name: 'ENTRA_CLIENT_ID', value: entraClientId }
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'ORGANIZER_UPN', value: organizerUpn }
        { name: 'ALLOWED_ATTENDEE_DOMAINS', value: allowedAttendeeDomains }
        { name: 'STORAGE_TABLE_ENDPOINT', value: storage.properties.primaryEndpoints.table }
        { name: 'SESSION_SECRET', value: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=session-secret)' }
        { name: 'TIME_ZONE', value: timeZone }
        { name: 'ROOM_DIRECTORY', value: roomDirectory }
        { name: 'SYNC_PRINCIPAL_ID', value: syncIdentity.properties.principalId }
        { name: 'BOOKING_DAY_START', value: bookingRules.dayStart }
        { name: 'BOOKING_DAY_END', value: bookingRules.dayEnd }
        { name: 'BOOKING_SLOT_MINUTES', value: string(bookingRules.slotMinutes) }
        { name: 'BOOKING_MAX_DURATION_MINUTES', value: string(bookingRules.maxDurationMinutes) }
        { name: 'BOOKING_HORIZON_DAYS', value: string(bookingRules.horizonDays) }
        { name: 'BOOKING_MAX_ACTIVE_PER_USER', value: string(bookingRules.maxActivePerUser) }
        { name: 'BOOKING_ALLOW_WEEKENDS', value: bookingRules.allowWeekends ? 'true' : 'false' }
      ]
    }
  }
  dependsOn: [
    vnet
    keyVaultSecretsUser
    storageTableContributor
  ]
}

// Domaine personnalisé : liaison du nom d'hôte (sans TLS), certificat managé gratuit, puis activation
// du TLS SNI dans un module (une même ressource ne peut pas être déclarée deux fois dans un fichier).
resource hostBinding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = if (useCustomDomain) {
  parent: app
  name: customDomain
  properties: {
    hostNameType: 'Verified'
    siteName: app.name
    customHostNameDnsRecordType: 'CName'
    sslState: 'Disabled'
  }
}

resource managedCertificate 'Microsoft.Web/certificates@2023-12-01' = if (useCustomDomain) {
  name: 'cert-${take(replace(customDomain, '.', '-'), 60)}'
  location: location
  tags: tags
  properties: {
    serverFarmId: plan.id
    canonicalName: customDomain
  }
  dependsOn: [hostBinding]
}

module hostBindingTls 'modules/hostname-tls.bicep' = if (useCustomDomain) {
  name: 'hostname-tls'
  params: {
    appName: app.name
    hostName: customDomain
    thumbprint: managedCertificate.?properties.thumbprint ?? ''
  }
}

// Sorties console du conteneur conservées sur le système de fichiers (lecture immédiate via Kudu,
// sans attendre l'ingestion Log Analytics), avec une rétention bornée.
resource appLogs 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: app
  name: 'logs'
  properties: {
    applicationLogs: { fileSystem: { level: 'Information' } }
    httpLogs: { fileSystem: { enabled: true, retentionInDays: 7, retentionInMb: 35 } }
    detailedErrorMessages: { enabled: false }
    failedRequestsTracing: { enabled: false }
  }
}

// Déploiement uniquement via Entra ID (OIDC GitHub) : pas d'identifiants FTP/SCM.
resource ftpCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}

resource scmCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false }
}

// ---------------------------------------------------------------- Journaux

resource appDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: app
  properties: {
    workspaceId: logAnalytics.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource tableDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: tableService
  properties: {
    workspaceId: logAnalytics.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
  }
}

resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: keyVault
  properties: {
    workspaceId: logAnalytics.id
    logs: [{ categoryGroup: 'audit', enabled: true }]
  }
}

// ---------------------------------------------------------------- Synchronisation des salles

// Identité distincte de celle du portail : elle seule lit les salles dans Exchange (rôle
// « View-Only Recipients ») et peut mettre à jour l'annuaire du portail (rôle RoomDirectory.Write).
resource syncIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${baseName}-sync'
  location: location
  tags: tags
}

resource automation 'Microsoft.Automation/automationAccounts@2023-11-01' = {
  name: 'aa-${baseName}'
  location: automationLocation
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${syncIdentity.id}': {} }
  }
  properties: {
    sku: { name: 'Basic' }
    publicNetworkAccess: true
    // Pas de webhooks ni de clés : seuls Entra ID et les planifications déclenchent le runbook.
    disableLocalAuth: true
  }
}

resource exchangeModule 'Microsoft.Automation/automationAccounts/modules@2023-11-01' = {
  parent: automation
  name: 'ExchangeOnlineManagement'
  properties: {
    contentLink: { uri: 'https://www.powershellgallery.com/api/v2/package/ExchangeOnlineManagement/${exchangeModuleVersion}' }
  }
}

// Le runbook (contenu, publication, planifications) est géré par scripts/deploy.ps1.
// Les valeurs des variables Automation sont des chaînes JSON, d'où les guillemets.
resource portalUrlVariable 'Microsoft.Automation/automationAccounts/variables@2023-11-01' = {
  parent: automation
  name: 'PortalUrl'
  properties: { value: '"${publicBaseUrl}"', isEncrypted: false }
}

resource portalAudienceVariable 'Microsoft.Automation/automationAccounts/variables@2023-11-01' = {
  parent: automation
  name: 'PortalAudience'
  properties: { value: empty(entraClientId) ? '""' : '"api://${entraClientId}"', isEncrypted: false }
}

resource exchangeOrganizationVariable 'Microsoft.Automation/automationAccounts/variables@2023-11-01' = {
  parent: automation
  name: 'ExchangeOrganization'
  properties: { value: '"${tenantInitialDomain}"', isEncrypted: false }
}

resource identityClientIdVariable 'Microsoft.Automation/automationAccounts/variables@2023-11-01' = {
  parent: automation
  name: 'IdentityClientId'
  properties: { value: '"${syncIdentity.properties.clientId}"', isEncrypted: false }
}

resource automationDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: automation
  properties: {
    workspaceId: logAnalytics.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
  }
}

// ---------------------------------------------------------------- Sorties

output appName string = app.name
output appUrl string = publicBaseUrl
output defaultAppUrl string = defaultBaseUrl
output customDomainVerificationId string = app.properties.customDomainVerificationId
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output resourceGroupName string = resourceGroup().name
output automationAccountName string = automation.name
output syncIdentityClientId string = syncIdentity.properties.clientId
output syncIdentityPrincipalId string = syncIdentity.properties.principalId

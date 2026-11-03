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

@description('URL publique si un domaine personnalisé est configuré. Vide = https://<app>.azurewebsites.net')
param customBaseUrl string = ''

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
var publicBaseUrl = empty(customBaseUrl) ? 'https://${appName}.azurewebsites.net' : customBaseUrl

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
resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-${baseName}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: 'snet-app'
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

var appSubnetId = vnet.properties.subnets[0].id

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
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource bookingsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'bookings'
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
    keyVaultSecretsUser
    storageTableContributor
  ]
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

// ---------------------------------------------------------------- Sorties

output appName string = app.name
output appUrl string = publicBaseUrl
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output resourceGroupName string = resourceGroup().name

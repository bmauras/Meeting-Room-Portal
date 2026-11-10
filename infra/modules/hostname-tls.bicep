// Active le TLS (SNI) sur un nom d'hôte déjà lié à l'App Service, avec le certificat managé.

param appName string
param hostName string
param thumbprint string

resource app 'Microsoft.Web/sites@2023-12-01' existing = {
  name: appName
}

resource hostBinding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = {
  parent: app
  name: hostName
  properties: {
    hostNameType: 'Verified'
    siteName: appName
    customHostNameDnsRecordType: 'CName'
    sslState: 'SniEnabled'
    thumbprint: thumbprint
  }
}

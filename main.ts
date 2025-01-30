import { Construct } from 'constructs';
import { App, TerraformStack, TerraformOutput } from 'cdktf';
import { AzurermProvider } from '@cdktf/provider-azurerm/lib/provider';
import { ResourceGroup } from '@cdktf/provider-azurerm/lib/resource-group';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Id } from '@cdktf/provider-random/lib/id';
import { Vnet } from './constructs/vnet';
import { Postgres } from './constructs/postgres';
import { Redis } from './constructs/redis';
import { FileShareConstruct } from './constructs/file-share';
import { KeyVaultConstruct } from './constructs/kv';
import { ContainerAppEnvConstruct } from './constructs/aca';

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // define resources here
    new AzurermProvider(this, 'azurerm', {
      features: [{}],
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
    });

    // Random provider for generating unique identifiers
    new RandomProvider(this, 'random', {});
    const randomId = new Id(this, 'random_id', {
      byteLength: 2,
    });

    const pjName = process.env.PROJECT_NAME || '';

    const rg = new ResourceGroup(this, 'rg', {
      name: `rg-${pjName}-${randomId.hex}`,
      location: 'Japan East',
    });

    const vnet = new Vnet(this, 'vnet', {
      name: `vnet-${pjName}${randomId.hex}`,
      resourceGroupName: rg.name,
      region: rg.location,
      ipPrefix: '10.0',
    });

    const psql = new Postgres(this, 'postgres', {
      resourceGroupName: rg.name,
      region: rg.location,
      vnetId: vnet.virtualNetwork.id,
      postgresSubnetId: vnet.postgresSubnet.id,
      serverName: `psql-${pjName}${randomId.hex}`,
      adminUser: process.env.POSTGRES_ADMIN_USER || 'difyroot',
      adminPassword: process.env.POSTGRES_PASSWORD || '',
    });

    const kv = new KeyVaultConstruct(this, 'kv', {
      resourceGroupName: rg.name,
      location: rg.location,
      name: `kv-${pjName}${randomId.hex}`,
      postgresPassword: process.env.POSTGRES_PASSWORD || '',
    });

    const redis = new Redis(this, 'redis', {
      resourceGroupName: rg.name,
      region: rg.location,
      vnetId: vnet.virtualNetwork.id,
      privateLinkSubnetId: vnet.privateLinkSubnet.id,
      name: `redis-${pjName}${randomId.hex}`,
    });

    const fileShare = new FileShareConstruct(this, 'fileshare', {
      storageAccountName: `stg${pjName}${randomId.hex}`,
      containerName: 'cdktf',
      resourceGroupName: rg.name,
      location: rg.location,
    });

    const aca = new ContainerAppEnvConstruct(this, 'container_apps', {
      name: `cae-${pjName}${randomId.hex}`,
      logAnalyticsName: `log-${pjName}${randomId.hex}`,
      resourceGroupName: rg.name,
      location: rg.location,
      subnetId: vnet.acaSubnet.id,
      keyVaultId: kv.vault.id,
      tenantId: kv.tenantId,
      storageAccount: {
        name: fileShare.storageAccount.name,
        accessKey: fileShare.storageAccount.primaryAccessKey,
        containerName: fileShare.container.name,
      },
      postgresConfig: {
        host: psql.hostname,
        adminUsername: process.env.POSTGRES_ADMIN_USER || 'difyroot',
        postgresSecretId: kv.postgresSecretId,
        difypgsqldb: psql.mainDatabase.name,
        pgvectordb: psql.vectorDatabase.name,
      },
      redisConfig: {
        host: redis.hostname,
        primaryKey: redis.primaryKey,
      },
      fileShares: {
        nginx: 'nginx',
        sandbox: 'sandbox',
        ssrfproxy: 'ssrfproxy',
      },
      minReplicas: 0,
      images: {
        sandbox: 'langgenius/dify-sandbox:latest',
        api: 'langgenius/dify-api:latest',
        web: 'langgenius/dify-web:latest',
      },
    });

    new TerraformOutput(this, 'nginx_domain', {
      value: `https://${aca.nginxApp.latestRevisionFqdn}`,
    });
  }
}

const app = new App();
new MyStack(app, 'cdktf-on-azure');
app.synth();

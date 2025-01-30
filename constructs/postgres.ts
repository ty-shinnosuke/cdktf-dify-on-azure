import { Construct } from 'constructs';
import { PostgresqlFlexibleServer } from '@cdktf/provider-azurerm/lib/postgresql-flexible-server';
import { PostgresqlFlexibleServerDatabase } from '@cdktf/provider-azurerm/lib/postgresql-flexible-server-database';
import { PostgresqlFlexibleServerConfiguration } from '@cdktf/provider-azurerm/lib/postgresql-flexible-server-configuration';
import { PrivateDnsZone } from '@cdktf/provider-azurerm/lib/private-dns-zone';
import { PrivateDnsZoneVirtualNetworkLink } from '@cdktf/provider-azurerm/lib/private-dns-zone-virtual-network-link';

interface PostgresConstructProps {
  resourceGroupName: string;
  region: string;
  vnetId: string;
  postgresSubnetId: string;
  serverName: string;
  adminUser: string;
  adminPassword: string;
}

export class Postgres extends Construct {
  public readonly server: PostgresqlFlexibleServer;
  public readonly mainDatabase: PostgresqlFlexibleServerDatabase;
  public readonly vectorDatabase: PostgresqlFlexibleServerDatabase;
  public readonly hostname: string;

  constructor(scope: Construct, id: string, props: PostgresConstructProps) {
    super(scope, id);

    // プライベートDNSゾーンの作成
    const privateDnsZone = new PrivateDnsZone(this, 'postgres_dns', {
      name: 'private.postgres.database.azure.com',
      resourceGroupName: props.resourceGroupName,
    });

    // VNetとプライベートDNSゾーンのリンク
    new PrivateDnsZoneVirtualNetworkLink(this, 'postgres_dns_link', {
      name: `link-${props.serverName}`,
      privateDnsZoneName: privateDnsZone.name,
      virtualNetworkId: props.vnetId,
      resourceGroupName: props.resourceGroupName,
    });

    // PostgreSQLフレキシブルサーバーの作成
    this.server = new PostgresqlFlexibleServer(this, 'postgres', {
      name: props.serverName,
      resourceGroupName: props.resourceGroupName,
      location: props.region,
      version: '16',
      delegatedSubnetId: props.postgresSubnetId,
      privateDnsZoneId: privateDnsZone.id,
      publicNetworkAccessEnabled: false,
      administratorLogin: props.adminUser,
      administratorPassword: props.adminPassword,
      zone: '1',
      storageMb: 32768,
      storageTier: 'P30',
      skuName: 'B_Standard_B1ms',
    });

    // メインデータベースの作成
    this.mainDatabase = new PostgresqlFlexibleServerDatabase(this, 'main_db', {
      name: 'difypgsqldb',
      serverId: this.server.id,
      collation: 'en_US.utf8',
      charset: 'utf8',
    });

    // pgvectorデータベースの作成
    this.vectorDatabase = new PostgresqlFlexibleServerDatabase(this, 'vector_db', {
      name: 'pgvector',
      serverId: this.server.id,
      collation: 'en_US.utf8',
      charset: 'utf8',
    });

    // 拡張機能の設定
    new PostgresqlFlexibleServerConfiguration(this, 'extensions', {
      name: 'azure.extensions',
      serverId: this.server.id,
      value: 'vector,uuid-ossp',
    });

    this.hostname = this.server.fqdn;
  }
}

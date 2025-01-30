import { Construct } from 'constructs';
import { KeyVault } from '@cdktf/provider-azurerm/lib/key-vault';
import { KeyVaultSecret } from '@cdktf/provider-azurerm/lib/key-vault-secret';
import { DataAzurermClientConfig } from '@cdktf/provider-azurerm/lib/data-azurerm-client-config';

interface KeyVaultConstructProps {
  resourceGroupName: string;
  location: string;
  name: string;
  postgresPassword?: string;
}

export class KeyVaultConstruct extends Construct {
  public readonly vault: KeyVault;
  public readonly tenantId: string;
  public readonly postgresSecretId: string;

  constructor(scope: Construct, id: string, props: KeyVaultConstructProps) {
    super(scope, id);

    // 現在のAzureクライアント設定を取得
    const currentClient = new DataAzurermClientConfig(this, 'current');
    this.tenantId = currentClient.tenantId;
    this.postgresSecretId = '';

    // Key Vaultの作成
    this.vault = new KeyVault(this, 'vault', {
      name: props.name,
      resourceGroupName: props.resourceGroupName,
      location: props.location,
      skuName: 'standard',
      tenantId: currentClient.tenantId,
      purgeProtectionEnabled: false,
      softDeleteRetentionDays: 7,

      accessPolicy: [
        {
          tenantId: currentClient.tenantId,
          objectId: currentClient.objectId,
          secretPermissions: ['Get', 'List', 'Set', 'Delete', 'Purge', 'Recover'],
        },
      ],
    });

    // シークレットの作成
    if (props.postgresPassword) {
      const postgresSecret = new KeyVaultSecret(this, 'secret-postgres-password', {
        name: 'postgres-admin-password',
        keyVaultId: this.vault.id,
        value: props.postgresPassword,
      });
      this.postgresSecretId = postgresSecret.id;
    }
  }
}

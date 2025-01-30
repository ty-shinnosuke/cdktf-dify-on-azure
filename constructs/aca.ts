import { Construct } from 'constructs';
import { ContainerAppEnvironment } from '@cdktf/provider-azurerm/lib/container-app-environment';
import { ContainerAppEnvironmentStorage } from '@cdktf/provider-azurerm/lib/container-app-environment-storage';
import { ContainerApp } from '@cdktf/provider-azurerm/lib/container-app';
import { LogAnalyticsWorkspace } from '@cdktf/provider-azurerm/lib/log-analytics-workspace';
import { KeyVaultAccessPolicyA } from '@cdktf/provider-azurerm/lib/key-vault-access-policy';

type storageAccount = {
  name: string;
  containerName: string;
  accessKey: string;
};

type postgresConfig = {
  host: string;
  adminUsername: string;
  postgresSecretId: string;
  difypgsqldb: string;
  pgvectordb: string;
};

type redisConfig = {
  host: string;
  primaryKey: string;
};

type fileShares = {
  nginx: string;
  sandbox: string;
  ssrfproxy: string;
};

type images = {
  sandbox: string;
  api: string;
  web: string;
};

interface ContainerAppEnvConfig {
  name: string;
  logAnalyticsName: string;
  resourceGroupName: string;
  location: string;
  subnetId: string;
  keyVaultId: string;
  tenantId: string;
  storageAccount: storageAccount;
  postgresConfig: postgresConfig;
  redisConfig: redisConfig;
  fileShares: fileShares;
  minReplicas: number;
  images: images;
}

export class ContainerAppEnvConstruct extends Construct {
  public readonly environment: ContainerAppEnvironment;
  public readonly logAnalytics: LogAnalyticsWorkspace;
  public readonly nginxApp: ContainerApp;

  constructor(scope: Construct, name: string, config: ContainerAppEnvConfig) {
    super(scope, name);

    // Log Analytics Workspace
    this.logAnalytics = new LogAnalyticsWorkspace(this, 'log_analytics', {
      name: config.logAnalyticsName,
      location: config.location,
      resourceGroupName: config.resourceGroupName,
      sku: 'PerGB2018',
      retentionInDays: 30,
    });

    // Container App Environment
    this.environment = new ContainerAppEnvironment(this, 'environment', {
      name: config.name,
      location: config.location,
      resourceGroupName: config.resourceGroupName,
      logAnalyticsWorkspaceId: this.logAnalytics.id,
      infrastructureSubnetId: config.subnetId,
      workloadProfile: [
        {
          name: 'Consumption',
          workloadProfileType: 'Consumption',
        },
      ],
    });

    // File Shares
    const nginxShare = new ContainerAppEnvironmentStorage(this, 'nginx_share', {
      name: 'nginxshare',
      containerAppEnvironmentId: this.environment.id,
      accountName: config.storageAccount.name,
      shareName: config.fileShares.nginx,
      accessKey: config.storageAccount.accessKey,
      accessMode: 'ReadWrite',
    });

    const ssrfproxyShare = new ContainerAppEnvironmentStorage(this, 'ssrfproxy_share', {
      name: 'ssrfproxyfileshare',
      containerAppEnvironmentId: this.environment.id,
      accountName: config.storageAccount.name,
      shareName: config.fileShares.ssrfproxy,
      accessKey: config.storageAccount.accessKey,
      accessMode: 'ReadWrite',
    });

    const sandboxShare = new ContainerAppEnvironmentStorage(this, 'sandbox_share', {
      name: 'sandbox',
      containerAppEnvironmentId: this.environment.id,
      accountName: config.storageAccount.name,
      shareName: config.fileShares.sandbox,
      accessKey: config.storageAccount.accessKey,
      accessMode: 'ReadWrite',
    });

    // Nginx Container App
    this.nginxApp = new ContainerApp(this, 'nginx', {
      name: 'nginx',
      containerAppEnvironmentId: this.environment.id,
      resourceGroupName: config.resourceGroupName,
      revisionMode: 'Single',

      template: {
        httpScaleRule: [
          {
            name: 'nginx',
            concurrentRequests: '10',
          },
        ],
        maxReplicas: 10,
        minReplicas: config.minReplicas,
        container: [
          {
            name: 'nginx',
            image: 'nginx:latest',
            cpu: 0.5,
            memory: '1Gi',
            volumeMounts: [
              {
                name: 'nginxconf',
                path: '/etc/nginx',
              },
            ],
          },
        ],
        volume: [
          {
            name: 'nginxconf',
            storageType: 'AzureFile',
            storageName: nginxShare.name,
          },
        ],
      },

      ingress: {
        targetPort: 80,
        externalEnabled: true,
        trafficWeight: [
          {
            percentage: 100,
            latestRevision: true,
          },
        ],
        transport: 'auto',
      },
    });

    // SSRF Proxy Container App
    new ContainerApp(this, 'ssrfproxy', {
      name: 'ssrfproxy',
      containerAppEnvironmentId: this.environment.id,
      resourceGroupName: config.resourceGroupName,
      revisionMode: 'Single',

      template: {
        tcpScaleRule: [
          {
            name: 'ssrfproxy',
            concurrentRequests: '10',
          },
        ],
        maxReplicas: 10,
        minReplicas: config.minReplicas,
        container: [
          {
            name: 'ssrfproxy',
            image: 'ubuntu/squid:latest',
            cpu: 0.5,
            memory: '1Gi',
            volumeMounts: [
              {
                name: 'ssrfproxy',
                path: '/etc/squid',
              },
            ],
          },
        ],
        volume: [
          {
            name: 'ssrfproxy',
            storageType: 'AzureFile',
            storageName: ssrfproxyShare.name,
          },
        ],
      },

      ingress: {
        targetPort: 3128,
        externalEnabled: false,
        trafficWeight: [
          {
            percentage: 100,
            latestRevision: true,
          },
        ],
        transport: 'auto',
      },
    });

    // Sandbox Container App
    new ContainerApp(this, 'sandbox', this.createSandboxAppConfig(config, sandboxShare));

    // Worker Container App
    const worker = new ContainerApp(this, 'worker', this.createWorkerAppConfig(config));
    this.addKeyVaultAccess(worker.identity.principalId, config.keyVaultId, config.tenantId);

    // API Container App
    const api = new ContainerApp(this, 'api', this.createApiAppConfig(config));
    this.addKeyVaultAccess(api.identity.principalId, config.keyVaultId, config.tenantId);

    // Web Container App
    new ContainerApp(this, 'web', this.createWebAppConfig(config));
  }

  /**
   * サンドボックス環境の設定を作成
   *
   * @param config - コンテナアプリケーション環境の設定オブジェクト
   * @param storage - コンテナアプリケーション環境のストレージ設定
   * @returns コンテナアプリケーションの構成オブジェクト
   *
   * @remarks
   * - TCPスケーリングルールを設定し、同時リクエスト数を10に制限
   * - レプリカ数は最小値から最大10まで自動でスケール
   * - プロキシを使用してネットワークアクセスを制御
   * - Azureファイルストレージをマウントして依存関係を保存
   * - 内部トラフィックのみを許可し、外部からの直接アクセスは無効化
   */
  private createSandboxAppConfig(config: ContainerAppEnvConfig, storage: ContainerAppEnvironmentStorage) {
    return {
      name: 'sandbox',
      containerAppEnvironmentId: this.environment.id,
      resourceGroupName: config.resourceGroupName,
      revisionMode: 'Single',
      template: {
        tcpScaleRule: [
          {
            name: 'sandbox',
            concurrentRequests: '10',
          },
        ],
        maxReplicas: 10,
        minReplicas: config.minReplicas,
        container: [
          {
            name: 'langgenius',
            image: config.images.sandbox,
            cpu: 0.5,
            memory: '1Gi',
            env: [
              { name: 'API_KEY', value: 'dify-sandbox' },
              { name: 'GIN_MODE', value: 'release' },
              { name: 'WORKER_TIMEOUT', value: '15' },
              { name: 'ENABLE_NETWORK', value: 'true' },
              { name: 'HTTP_PROXY', value: 'http://ssrfproxy:3128' },
              { name: 'HTTPS_PROXY', value: 'http://ssrfproxy:3128' },
              { name: 'SANDBOX_PORT', value: '8194' },
            ],
            volumeMounts: [
              {
                name: 'sandbox',
                path: '/dependencies',
              },
            ],
          },
        ],
        volume: [
          {
            name: 'sandbox',
            storageType: 'AzureFile',
            storageName: storage.name,
          },
        ],
      },
      ingress: {
        targetPort: 8194,
        externalEnabled: false,
        trafficWeight: [
          {
            percentage: 100,
            latestRevision: true,
          },
        ],
        transport: 'tcp',
      },
    };
  }

  /**
   * ワーカーアプリケーションの設定を作成
   *
   * @param config - コンテナアプリ環境の設定オブジェクト
   * @returns ワーカーアプリケーションの設定オブジェクト
   *
   * @remarks
   * - 単一リビジョンモード
   * - TCPスケールルール（最大10の同時リクエスト）
   * - レプリカ数の制限（最小値は設定から、最大値は10）
   * - Langgenius コンテナの設定（CPU: 2, メモリ: 4Gi）
   */
  private createWorkerAppConfig(config: ContainerAppEnvConfig) {
    return {
      name: 'worker',
      containerAppEnvironmentId: this.environment.id,
      resourceGroupName: config.resourceGroupName,
      revisionMode: 'Single',
      identity: {
        type: 'SystemAssigned',
      },
      template: {
        tcpScaleRule: [
          {
            name: 'worker',
            concurrentRequests: '10',
          },
        ],
        maxReplicas: 10,
        minReplicas: config.minReplicas,
        container: [
          {
            name: 'langgenius',
            image: config.images.api,
            cpu: 2,
            memory: '4Gi',
            env: this.createWorkerApiEnvVars(config),
          },
        ],
      },
      secret: [
        {
          name: 'postgres-db-password',
          keyVaultSecretId: config.postgresConfig.postgresSecretId,
          identity: 'System',
        },
      ],
    };
  }

  /**
   * API構成の設定を作成
   * @param config - コンテナアプリの環境設定
   * @returns Container App構成オブジェクト
   *
   * - アプリ名: 'api'
   * - リビジョンモード: Single
   * - TCPスケーリングルール (10の同時リクエスト)
   * - レプリカ数: 最小値はconfig.minReplicas、最大値は10
   * - langgenius コンテナ設定（CPU: 2コア、メモリ: 4GB）
   * - TCP イングレス設定（内部公開、ポート5001）
   */
  private createApiAppConfig(config: ContainerAppEnvConfig) {
    return {
      name: 'api',
      containerAppEnvironmentId: this.environment.id,
      resourceGroupName: config.resourceGroupName,
      revisionMode: 'Single',
      identity: {
        type: 'SystemAssigned',
      },
      template: {
        tcpScaleRule: [
          {
            name: 'api',
            concurrentRequests: '10',
          },
        ],
        maxReplicas: 10,
        minReplicas: config.minReplicas,
        container: [
          {
            name: 'langgenius',
            image: config.images.api,
            cpu: 2,
            memory: '4Gi',
            env: this.createWorkerApiEnvVars(config, true),
          },
        ],
      },
      secret: [
        {
          name: 'postgres-db-password',
          keyVaultSecretId: config.postgresConfig.postgresSecretId,
          identity: 'System',
        },
      ],
      ingress: {
        targetPort: 5001,
        exposedPort: 5001,
        externalEnabled: false,
        trafficWeight: [
          {
            percentage: 100,
            latestRevision: true,
          },
        ],
        transport: 'tcp',
      },
    };
  }

  /**
   * ウェブアプリケーションの構成を作成
   * @param config - コンテナアプリ環境の設定
   * @returns ContainerAppの構成オブジェクト
   * - リビジョンモード: シングル
   * - TCPスケール規則
   * - レプリカ設定
   * - コンテナ設定（langgenius）
   * - イングレス設定（TCP 3000ポート）
   */
  private createWebAppConfig(config: ContainerAppEnvConfig) {
    return {
      name: 'web',
      containerAppEnvironmentId: this.environment.id,
      resourceGroupName: config.resourceGroupName,
      revisionMode: 'Single',
      template: {
        tcpScaleRule: [
          {
            name: 'web',
            concurrentRequests: '10',
          },
        ],
        maxReplicas: 10,
        minReplicas: config.minReplicas,
        container: [
          {
            name: 'langgenius',
            image: config.images.web,
            cpu: 1,
            memory: '2Gi',
            env: [
              { name: 'CONSOLE_API_URL', value: '' },
              { name: 'APP_API_URL', value: '' },
              { name: 'SENTRY_DSN', value: '' },
            ],
          },
        ],
      },
      ingress: {
        targetPort: 3000,
        exposedPort: 3000,
        externalEnabled: false,
        trafficWeight: [
          {
            percentage: 100,
            latestRevision: true,
          },
        ],
        transport: 'tcp',
      },
    };
  }

  /**
   * APIとワーカーコンテナのための環境変数を生成する
   * @param config - コンテナアプリの環境設定
   * @param isApi - APIコンテナの場合はtrue、ワーカーコンテナの場合はfalse
   * @returns 環境変数の配列 (name-valueペア)
   * @remarks
   * - 基本的なDB接続情報
   * - Azure Blob Storage設定
   * - PGVector設定
   * - Redis設定（設定がある場合）
   * - API固有の設定（isApi=trueの場合）
   */
  private createWorkerApiEnvVars(config: ContainerAppEnvConfig, isApi: boolean = false) {
    /* base env vars
      SEACRET_KEY = セッションクッキーを安全に署名し、データベース上の機密情報を暗号化するためのキー。
      https://docs.dify.ai/ja-jp/getting-started/install-self-hosted/environments
    */
    const baseEnvVars = [
      { name: 'MODE', value: isApi ? 'api' : 'worker' },
      { name: 'LOG_LEVEL', value: 'INFO' },
      { name: 'SECRET_KEY', value: 'sk-9f73s3ljTXVcMT3Blb3ljTqtsKiGHXVcMT3BlbkFJLK7U' },
      { name: 'DB_USERNAME', value: config.postgresConfig.adminUsername },
      { name: 'DB_PASSWORD', secretName: 'postgres-db-password' },
      { name: 'DB_HOST', value: config.postgresConfig.host },
      { name: 'DB_PORT', value: '5432' },
      { name: 'DB_DATABASE', value: config.postgresConfig.difypgsqldb },
      { name: 'AZURE_BLOB_ACCOUNT_NAME', value: config.storageAccount.name },
      { name: 'AZURE_BLOB_ACCOUNT_KEY', value: config.storageAccount.accessKey },
      { name: 'AZURE_BLOB_ACCOUNT_URL', value: `https://${config.storageAccount.name}.blob.core.windows.net` },
      { name: 'AZURE_BLOB_CONTAINER_NAME', value: config.storageAccount.containerName },
      { name: 'VECTOR_STORE', value: 'pgvector' },
      { name: 'PGVECTOR_HOST', value: config.postgresConfig.host },
      { name: 'PGVECTOR_HOST', value: '5432' },
      { name: 'PGVECTOR_USER', value: config.postgresConfig.adminUsername },
      { name: 'PGVECTOR_PASSWORD', secretName: 'postgres-db-password' },
      { name: 'PGVECTOR_DATABASE', value: config.postgresConfig.pgvectordb },
      { name: 'INDEXING_MAX_SEGMENTATION_TOKENS_LENGTH', value: '1000' },
    ];

    if (config.redisConfig) {
      baseEnvVars.push(
        { name: 'REDIS_HOST', value: config.redisConfig.host },
        { name: 'REDIS_PORT', value: '6379' },
        { name: 'REDIS_PASSWORD', value: config.redisConfig.primaryKey },
        { name: 'REDIS_USE_SSL', value: 'false' },
        { name: 'REDIS_DB', value: '0' },
        { name: 'CELERY_BROKER_URL', value: `redis://:${config.redisConfig.primaryKey}@${config.redisConfig.host}:6379/1` }
      );
    }

    if (isApi) {
      baseEnvVars.push(
        { name: 'WEB_API_CORS_ALLOW_ORIGINS', value: '*' },
        { name: 'CONSOLE_CORS_ALLOW_ORIGINS', value: '*' },
        { name: 'CODE_EXECUTION_API_KEY', value: 'dify-sandbox' },
        { name: 'CODE_EXECUTION_ENDPOINT', value: 'http://sandbox:8194' },
        { name: 'CODE_MAX_NUMBER', value: '9223372036854775807' },
        { name: 'CODE_MIN_NUMBER', value: '-9223372036854775808' },
        { name: 'CODE_MAX_STRING_LENGTH', value: '80000' },
        { name: 'TEMPLATE_TRANSFORM_MAX_LENGTH', value: '80000' },
        { name: 'CODE_MAX_OBJECT_ARRAY_LENGTH', value: '30' },
        { name: 'CODE_MAX_STRING_ARRAY_LENGTH', value: '30' },
        { name: 'CODE_MAX_NUMBER_ARRAY_LENGTH', value: '1000' },
        { name: 'CONSOLE_WEB_URL', value: '' },
        { name: 'INIT_PASSWORD', value: '' },
        { name: 'CONSOLE_API_URL', value: '' },
        { name: 'SERVICE_API_URL', value: '' },
        { name: 'APP_WEB_URL', value: '' },
        { name: 'FILES_URL', value: '' },
        { name: 'FILES_ACCESS_TIMEOUT', value: '300' },
        { name: 'MIGRATION_ENABLED', value: 'true' },
        { name: 'SENTRY_DSN', value: '' },
        { name: 'SENTRY_TRACES_SAMPLE_RATE', value: '1.0' },
        { name: 'SENTRY_PROFILES_SAMPLE_RATE', value: '1.0' },
        { name: 'STORAGE_TYPE', value: 'azure-blob' }
      );
    }

    return baseEnvVars;
  }

  /**
   * KeyVaultへのアクセスポリシーを追加する
   * @param principalId - アクセスを付与するプリンシパルID
   * @param keyVaultId - KeyVaultのリソースID
   * @param tenantId - テナントID
   * @remarks
   * - Managed Identityに対してKeyVaultのシークレットの取得権限を付与
   * - Get権限のみを付与
   */
  private kvPolicyCounter = 0;
  private addKeyVaultAccess(principalId: string, keyVaultId: string, tenantId: string): void {
    new KeyVaultAccessPolicyA(this, `keyvault-access-${++this.kvPolicyCounter}`, {
      keyVaultId: keyVaultId,
      tenantId: tenantId,
      objectId: principalId,
      secretPermissions: ['Get'],
    });
  }
}

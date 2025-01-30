import { Construct } from 'constructs';
import { StorageAccount } from '@cdktf/provider-azurerm/lib/storage-account';
import { StorageContainer } from '@cdktf/provider-azurerm/lib/storage-container';
import { StorageShare } from '@cdktf/provider-azurerm/lib/storage-share';
import { StorageShareFile } from '@cdktf/provider-azurerm/lib/storage-share-file';
import { StorageShareDirectory } from '@cdktf/provider-azurerm/lib/storage-share-directory';
import * as fs from 'fs';
import * as path from 'path';

interface FileShareConstructProps {
  readonly storageAccountName: string;
  readonly containerName: string;
  readonly resourceGroupName: string;
  readonly location: string;
}

interface FileShareModuleProps {
  readonly storageAccountName: string;
  readonly localMountDir: string;
  readonly shareName: string;
  readonly quota?: number;
}

export class FileShareConstruct extends Construct {
  public readonly storageAccount: StorageAccount;
  public readonly container: StorageContainer;
  private readonly shares: { [key: string]: StorageShare } = {};

  constructor(scope: Construct, id: string, props: FileShareConstructProps) {
    super(scope, id);

    // ストレージアカウントの作成
    this.storageAccount = new StorageAccount(this, 'storage_account', {
      name: props.storageAccountName,
      resourceGroupName: props.resourceGroupName,
      location: props.location,
      accountTier: 'Standard',
      accountReplicationType: 'LRS',
    });

    // Blobコンテナの作成
    this.container = new StorageContainer(this, 'container', {
      name: props.containerName,
      storageAccountName: this.storageAccount.name,
      containerAccessType: 'private',
    });

    // 3つのFile共有を作成
    this.createFileShare({
      storageAccountName: this.storageAccount.name,
      localMountDir: path.join(__dirname, 'mountfiles/nginx'),
      shareName: 'nginx',
    });

    this.createFileShare({
      storageAccountName: this.storageAccount.name,
      localMountDir: path.join(__dirname, 'mountfiles/sandbox'),
      shareName: 'sandbox',
    });

    this.createFileShare({
      storageAccountName: this.storageAccount.name,
      localMountDir: path.join(__dirname, 'mountfiles/ssrfproxy'),
      shareName: 'ssrfproxy',
    });
  }

  /**
   * 指定されたディレクトリ内のすべてのファイルパスを再帰的に取得
   *
   * @param dir - 検索対象のディレクトリパス
   * @returns ディレクトリ内のすべてのファイルの絶対パスの配列
   *
   * @remarks
   * - サブディレクトリも再帰的に検索します
   * - 同期処理で実行されます
   */
  private getAllFiles(dir: string): string[] {
    const results: string[] = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        results.push(...this.getAllFiles(fullPath));
      } else {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * 指定されたファイルパスのリストから、マウントディレクトリを基準とした相対パスを抽出
   * @param files - 処理対象のファイルパスの配列
   * @param mountDir - マウントディレクトリのパス
   * @returns ソート済みのユニークなディレクトリパスの配列
   */
  private getDirectories(files: string[], mountDir: string): string[] {
    const directories = new Set<string>();

    files.forEach((file) => {
      const dir = path.dirname(path.relative(mountDir, file));
      if (dir !== '' && dir !== mountDir && dir !== '.') {
        directories.add(dir);
      }
    });

    return Array.from(directories).sort();
  }

  /**
   * 指定されたファイル一覧をルートディレクトリのファイルとサブディレクトリのファイルに分類
   *
   * @param files - 分類するファイルパスの配列
   * @param mountDir - マウントディレクトリのパス
   * @returns オブジェクトとして以下を返却:
   *          - rootFiles: マウントディレクトリ直下のファイル一覧
   *          - subdirFiles: サブディレクトリにあるファイル一覧
   */
  private categorizeFiles(files: string[], mountDir: string): { rootFiles: string[]; subdirFiles: string[] } {
    const rootFiles: string[] = [];
    const subdirFiles: string[] = [];

    files.forEach((file) => {
      if (path.dirname(file) === mountDir) {
        rootFiles.push(file);
      } else {
        subdirFiles.push(file);
      }
    });

    return { rootFiles, subdirFiles };
  }

  /**
   * ファイル共有を作成し、ローカルディレクトリの内容をアップロードする
   *
   * @param props - ファイル共有モジュールのプロパティ
   * @param props.shareName - 作成するファイル共有の名前
   * @param props.storageAccountName - ストレージアカウント名
   * @param props.quota - ファイル共有のクォータ(GB)。デフォルトは50GB
   * @param props.localMountDir - アップロードするローカルディレクトリのパス
   *
   * @returns 作成されたStorageShareインスタンス
   *
   * @remarks
   * - 指定されたローカルディレクトリ内のすべてのファイルとディレクトリを再帰的にアップロード
   * - ディレクトリ構造を保持したままファイルを転送
   * - ルートファイルとサブディレクトリのファイルを別々に処理
   */
  private createFileShare(props: FileShareModuleProps): StorageShare {
    const share = new StorageShare(this, `share_${props.shareName}`, {
      name: props.shareName,
      storageAccountName: props.storageAccountName,
      quota: props.quota || 50,
    });

    this.shares[props.shareName] = share;

    // ファイルの列挙
    const files = this.getAllFiles(props.localMountDir);

    // サブディレクトリの作成
    const directories = this.getDirectories(files, props.localMountDir);

    const shareDirectories = directories.map(
      (dir) =>
        new StorageShareDirectory(this, `dir_${props.shareName}_${dir.replace(/\//g, '_')}`, {
          name: dir,
          storageShareId: share.id,
        })
    );

    // ファイルの分類
    const { rootFiles, subdirFiles } = this.categorizeFiles(files, props.localMountDir);

    // ルート直下のファイルをアップロード
    rootFiles.forEach((file) => {
      new StorageShareFile(this, `file_${props.shareName}_root_${path.basename(file)}`, {
        name: path.basename(file),
        storageShareId: share.id,
        source: file,
        dependsOn: shareDirectories,
      });
    });

    // サブディレクトリのファイルをアップロード
    subdirFiles.forEach((file) => {
      const relativePath = path.relative(props.localMountDir, file);
      new StorageShareFile(this, `file_${props.shareName}_${relativePath.replace(/\//g, '_')}`, {
        name: path.basename(file),
        storageShareId: share.id,
        source: file,
        path: path.dirname(relativePath) === './' ? './' : path.dirname(relativePath),
        dependsOn: shareDirectories,
      });
    });

    return share;
  }
}

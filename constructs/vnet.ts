import { Construct } from 'constructs';
import { VirtualNetwork } from '@cdktf/provider-azurerm/lib/virtual-network';
import { Subnet } from '@cdktf/provider-azurerm/lib/subnet';

interface NetworkConstructProps {
  name: string;
  resourceGroupName: string;
  region: string;
  ipPrefix: string;
}

export class Vnet extends Construct {
  public readonly virtualNetwork: VirtualNetwork;
  public readonly privateLinkSubnet: Subnet;
  public readonly acaSubnet: Subnet;
  public readonly postgresSubnet: Subnet;

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    // 仮想ネットワークの作成
    this.virtualNetwork = new VirtualNetwork(this, 'vnet', {
      name: props.name,
      addressSpace: [`${props.ipPrefix}.0.0/16`],
      location: props.region,
      resourceGroupName: props.resourceGroupName,
    });

    // PrivateLink用サブネットの作成
    this.privateLinkSubnet = new Subnet(this, 'privatelinksubnet', {
      name: 'PrivateLinkSubnet',
      resourceGroupName: props.resourceGroupName,
      virtualNetworkName: this.virtualNetwork.name,
      addressPrefixes: [`${props.ipPrefix}.1.0/24`],
    });

    // ACA用サブネットの作成
    this.acaSubnet = new Subnet(this, 'acasubnet', {
      name: 'ACASubnet',
      resourceGroupName: props.resourceGroupName,
      virtualNetworkName: this.virtualNetwork.name,
      addressPrefixes: [`${props.ipPrefix}.16.0/20`],
      delegation: [
        {
          name: 'aca-delegation',
          serviceDelegation: {
            name: 'Microsoft.App/environments',
            actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'],
          },
        },
      ],
    });

    this.postgresSubnet = new Subnet(this, 'postgressubnet', {
      name: 'PostgresSubnet',
      resourceGroupName: props.resourceGroupName,
      virtualNetworkName: this.virtualNetwork.name,
      addressPrefixes: [`${props.ipPrefix}.2.0/24`],
      serviceEndpoints: ['Microsoft.Storage'],
      delegation: [
        {
          name: 'postgres-delegation',
          serviceDelegation: {
            name: 'Microsoft.DBforPostgreSQL/flexibleServers',
            actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'],
          },
        },
      ],
    });
  }
}

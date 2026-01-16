export interface TransactionFlow {
  hash: string;
  from: string;
  to: string;
  value: string; // in ETH
  valueUsd?: string; // USD value for ETH transactions
  timestamp: number;
  blockNumber: number;
  type: 'incoming' | 'outgoing';
  tokenTransfers?: TokenTransfer[];
}

export interface TokenTransfer {
  contractAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  decimals?: number;
  value: string;
  valueUsd?: string; // USD value of the token transfer
  tokenPrice?: number; // Current token price in USD
  from: string;
  to: string;
}

export interface AddressFlow {
  address: string;
  totalValueUsd: string; // Total USD value of all transactions with this address
  transactionCount: number; // Number of transactions with this address
}

export interface WalletTraceResponse {
  walletAddress: string;
  summary: {
    totalIncoming: string;
    totalIncomingUsd?: string;
    totalOutgoing: string;
    totalOutgoingUsd?: string;
    netFlow: string;
    netFlowUsd?: string;
    transactionCount: number;
    uniqueAddresses: {
      sentTo: string[];
      receivedFrom: string[];
    };
    topInflowSources?: AddressFlow[]; // Top 10 addresses that sent money to this wallet (by USD value)
    topOutflowSources?: AddressFlow[]; // Top 10 addresses that received money from this wallet (by USD value)
  };
  transactions: TransactionFlow[];
  pageKey?: string;
  // Graph structure for multi-hop tracing
  graph?: WalletGraph;
  truncated?: boolean; // True if results were truncated due to high transaction volume
  truncationWarning?: string; // Warning message if truncation occurred
}

export interface WalletGraph {
  centerNode: string; // The initial wallet address
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  address: string;
  hop: number; // 0 = center, 1 = first order, 2 = second order, etc.
  is_contract?: boolean; // Optional: true if address is a smart contract
}

export interface GraphEdge {
  from: string;
  to: string;
  tx_hash: string; // Transaction hash
  timestamp?: number; // Transaction timestamp (if available)
  blockNumber: number; // Block number
  asset: string; // "ETH" or "token contract address + symbol" (e.g., "0x... + USDC")
  amount: string; // Amount of asset transferred
  usd_value?: string; // USD value (best effort, can be undefined for tokens)
}
